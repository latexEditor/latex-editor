const vscode = require('vscode');
const { randomUUID } = require('crypto');

const port = Number(process.env.LATEX_EDITOR_BRIDGE_PORT || 0);
const token = process.env.LATEX_EDITOR_BRIDGE_TOKEN || '';
const endpoint = port ? `http://127.0.0.1:${port}` : '';
const documents = new Map();
const applyingRemote = new WeakSet();
const pendingChanges = new Map();
const pendingSelections = new Map();
const remoteCursors = new Map();
const suppressedFileEvents = new Map();
const PENDING_FILE_OPERATIONS = 'pendingFileOperationsV1';
const MAX_PENDING_FILE_OPERATIONS = 1000;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
let extensionContext = null;
let sessionRole = null;
let fileOperationWrite = Promise.resolve();
let disposed = false;

function relativeUri(uri) {
  if (uri.scheme !== 'file') return null;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return null;
  const value = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (value.startsWith('../') || value === '..') return null;
  return /\.(?:tex|bib|sty|cls|md)$/i.test(value) ? value : null;
}

function relativePath(document) { return relativeUri(document.uri); }

function projectUri(path) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, ...path.split('/')) : null;
}

function parentUri(uri) {
  const parts = uri.path.split('/');
  parts.pop();
  return uri.with({ path: parts.join('/') || '/' });
}

function markSuppressed(...paths) {
  for (const path of paths) {
    clearTimeout(suppressedFileEvents.get(path));
    suppressedFileEvents.set(path, setTimeout(() => suppressedFileEvents.delete(path), 1500));
  }
}

function consumeSuppressed(path) {
  const timer = suppressedFileEvents.get(path);
  if (!timer) return false;
  clearTimeout(timer);
  suppressedFileEvents.delete(path);
  return true;
}

async function exists(uri) {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

async function scanFiles() {
  const uris = await vscode.workspace.findFiles('**/*.{tex,bib,sty,cls,md}', '{**/build/**,**/.*/**}', 5000);
  return uris.map(relativeUri).filter(Boolean).sort();
}

async function resetDraftsFromDisk(requestId) {
  try {
    const paths = await scanFiles();
    await post({ type: 'draft:reset:begin', requestId, paths });
    let count = 0;
    for (const path of paths) {
      const uri = projectUri(path);
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`${path} vượt quá giới hạn 1 MiB.`);
      await post({
        type: 'draft:reset:document', requestId, path,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      });
      count += 1;
    }
    await post({ type: 'draft:reset:end', requestId, count });
  } catch (error) {
    await post({ type: 'draft:reset:failed', requestId, error: error.message }).catch(() => {});
  }
}

function pendingFileOperations() {
  const value = extensionContext?.workspaceState.get(PENDING_FILE_OPERATIONS, []);
  return Array.isArray(value) ? value.filter((operation) => operation && typeof operation.operationId === 'string') : [];
}

function updatePendingFileOperations(update) {
  const task = fileOperationWrite.catch(() => {}).then(async () => {
    const next = update(pendingFileOperations());
    await extensionContext?.workspaceState.update(PENDING_FILE_OPERATIONS, next);
    return next;
  });
  fileOperationWrite = task;
  return task;
}

async function queueFileOperation(operation) {
  if (!extensionContext || sessionRole === 'viewer') {
    if (sessionRole === 'viewer') void vscode.window.showWarningMessage('Project chỉ có quyền xem; thay đổi file không được đồng bộ.');
    return;
  }
  const queued = { ...operation, operationId: randomUUID(), queuedAt: Date.now() };
  const pending = await updatePendingFileOperations((current) => {
    if (current.length >= MAX_PENDING_FILE_OPERATIONS) return current;
    return [...current, queued];
  });
  if (!pending.some((item) => item.operationId === queued.operationId)) {
    void vscode.window.showErrorMessage('Hàng đợi đồng bộ file đã đầy. Hãy kết nối mạng trước khi tiếp tục thay đổi cấu trúc project.');
    return;
  }
  await post(queued);
}

async function resendPendingFileOperations() {
  await fileOperationWrite.catch(() => {});
  for (const operation of pendingFileOperations()) await post(operation);
}

async function acknowledgeFileOperation(event) {
  if (!extensionContext) return;
  await updatePendingFileOperations((pending) => pending.filter((operation) => operation.operationId !== event.operationId));
  if (event.accepted === false) {
    const reasons = {
      read_only: 'Project chỉ có quyền xem.', file_exists: 'Tên file đích đã tồn tại.',
      file_missing: 'File nguồn không còn tồn tại.', manifest_full: 'Project có quá nhiều file trong manifest.'
    };
    void vscode.window.showWarningMessage(`Không thể đồng bộ thao tác file: ${reasons[event.code] || event.code || 'Worker từ chối thao tác.'}`);
  }
}

async function applyFileEvent(event) {
  if (event.type === 'filesystem:state') {
    const entries = new Map((event.entries || []).map((entry) => [entry.path, entry]));
    for (const entry of entries.values()) {
      if (!projectUri(entry.path)) continue;
      await applyFileEvent({ type: entry.deleted ? 'file:delete' : 'file:create', path: entry.path });
    }
    for (const path of await scanFiles()) {
      if (!entries.has(path)) await queueFileOperation({ type: 'file:create', path });
    }
    return;
  }
  if (event.type === 'file:rename') {
    const oldUri = projectUri(event.oldPath);
    const newUri = projectUri(event.newPath);
    if (!oldUri || !newUri) return;
    markSuppressed(event.oldPath, event.newPath);
    if (await exists(oldUri)) {
      await vscode.workspace.fs.createDirectory(parentUri(newUri));
      await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
    } else if (!(await exists(newUri))) {
      await vscode.workspace.fs.createDirectory(parentUri(newUri));
      await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
    }
    return;
  }
  const uri = projectUri(event.path);
  if (!uri) return;
  markSuppressed(event.path);
  if (event.type === 'file:create' && !(await exists(uri))) {
    await vscode.workspace.fs.createDirectory(parentUri(uri));
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  }
  if (event.type === 'file:delete' && await exists(uri)) {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
  }
}

async function post(message) {
  if (!endpoint || !token || disposed) return;
  const response = await fetch(endpoint + '/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LaTeX-Editor-Bridge-Token': token },
    body: JSON.stringify(message)
  });
  if (!response.ok) throw new Error(`Collaboration bridge returned ${response.status}`);
}

async function openDocument(document) {
  const file = relativePath(document);
  if (!file || document.isClosed || document.getText().length > 1024 * 1024) return;
  documents.set(file, document);
  await post({ type: 'document:open', path: file, text: document.getText() });
}

async function applyRemote(event) {
  const document = documents.get(event.path)
    || vscode.workspace.textDocuments.find((candidate) => relativePath(candidate) === event.path);
  if (!document || document.getText() === event.text) return;
  const edit = new vscode.WorkspaceEdit();
  const end = document.positionAt(document.getText().length);
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), event.text);
  documents.set(event.path, document);
  applyingRemote.add(document);
  try {
    await vscode.workspace.applyEdit(edit);
    await document.save();
  } finally {
    applyingRemote.delete(document);
  }
}

function cursorColor(userId) {
  const colors = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2'];
  let hash = 0;
  for (const character of userId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function cursorDecorations(user) {
  let decorations = remoteCursors.get(user.id)?.decorations;
  if (decorations) return decorations;
  const color = cursorColor(user.id);
  const name = (user.name || 'Thành viên').trim();
  decorations = {
    cursor: vscode.window.createTextEditorDecorationType({
      borderLeft: `3px solid ${color}`,
      after: {
        contentText: ` ${name} `,
        backgroundColor: color,
        color: '#ffffff',
        fontSize: '11px',
        fontWeight: 'bold',
        lineHeight: '1',
        margin: '0 0 0 2px',
        borderRadius: '3px'
      }
    }),
    selection: vscode.window.createTextEditorDecorationType({
      backgroundColor: `${color}35`,
      border: `1px dashed ${color}80`
    })
  };
  return decorations;
}

function renderCursor(event) {
  const previous = remoteCursors.get(event.user.id);
  const decorations = previous?.decorations || cursorDecorations(event.user);
  remoteCursors.set(event.user.id, { ...event, decorations });
  for (const editor of vscode.window.visibleTextEditors) {
    if (relativePath(editor.document) !== event.path) {
      editor.setDecorations(decorations.cursor, []);
      editor.setDecorations(decorations.selection, []);
      continue;
    }
    const cursors = [];
    const selections = [];
    for (const selection of event.selections || []) {
      const anchor = editor.document.positionAt(selection.anchor);
      const active = editor.document.positionAt(selection.active);
      const range = new vscode.Range(anchor, active);
      const hoverMessage = `${event.user.name || 'Thành viên'} đang chỉnh sửa`;
      cursors.push({ range: new vscode.Range(active, active), hoverMessage });
      if (!range.isEmpty) selections.push({ range, hoverMessage });
    }
    editor.setDecorations(decorations.cursor, cursors);
    editor.setDecorations(decorations.selection, selections);
  }
}

function removeCursor(userId) {
  const entry = remoteCursors.get(userId);
  if (!entry) return;
  entry.decorations.cursor.dispose();
  entry.decorations.selection.dispose();
  remoteCursors.delete(userId);
}

async function jumpToUserCursor(event) {
  const userId = event.userId;
  const remote = remoteCursors.get(userId) || (event.cursor?.path ? event.cursor : null);
  if (!remote || !remote.path) {
    void vscode.window.setStatusBarMessage('$(info) Thành viên chưa có con trỏ hoạt động trong tài liệu', 3000);
    return;
  }
  try {
    const uri = projectUri(remote.path);
    if (!uri) return;
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const selection = remote.selections?.[0];
    if (selection) {
      const activeOffset = Math.min(Math.max(0, selection.active), document.getText().length);
      const targetPos = document.positionAt(activeOffset);
      editor.selection = new vscode.Selection(targetPos, targetPos);
      editor.revealRange(new vscode.Range(targetPos, targetPos), vscode.TextEditorRevealType.InCenter);
    }
    const name = remote.user?.name || 'thành viên';
    void vscode.window.setStatusBarMessage(`$(eye) Đang theo dõi con trỏ của ${name}`, 4000);
  } catch (error) {
    console.error('Failed to jump to user cursor:', error);
  }
}

async function poll() {
  while (!disposed && endpoint && token) {
    try {
      const response = await fetch(endpoint + '/events', { headers: { 'X-LaTeX-Editor-Bridge-Token': token } });
      if (!response.ok) throw new Error(`Collaboration bridge returned ${response.status}`);
      const body = await response.json();
      for (const event of body.events || []) {
        if (event.type === 'document:remote' && typeof event.path === 'string' && typeof event.text === 'string') {
          await applyRemote(event);
        }
        if (event.type === 'session' && event.role === 'viewer') {
          void vscode.window.setStatusBarMessage('$(eye) Project chỉ có quyền xem', 5000);
        }
        if (event.type === 'session') sessionRole = event.role || null;
        if (event.type === 'documents:rescan') {
          await resendPendingFileOperations();
          for (const document of vscode.workspace.textDocuments) await openDocument(document);
          await post({ type: 'filesystem:snapshot', paths: await scanFiles() });
        }
        if (event.type === 'draft:reset-request' && event.requestId) await resetDraftsFromDisk(event.requestId);
        if (['filesystem:state', 'file:create', 'file:delete', 'file:rename'].includes(event.type)) {
          await applyFileEvent(event);
        }
        if (event.type === 'cursor:remote' && event.user?.id && Array.isArray(event.selections)) renderCursor(event);
        if (event.type === 'cursor:leave' && event.userId) removeCursor(event.userId);
        if (event.type === 'cursor:jump' && event.userId) await jumpToUserCursor(event);
        if (event.type === 'file:ack' && event.operationId) await acknowledgeFileOperation(event);
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function activate(context) {
  if (!endpoint || !token) return;
  extensionContext = context;
  disposed = false;
  fileOperationWrite = Promise.resolve();
  for (const document of vscode.workspace.textDocuments) void openDocument(document).catch(() => {});
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => void openDocument(document).catch(() => {})));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
    const file = relativePath(document);
    if (file) documents.delete(file);
  }));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles((event) => {
    for (const uri of event.files) {
      const file = relativeUri(uri);
      if (!file || consumeSuppressed(file)) continue;
      void queueFileOperation({ type: 'file:create', path: file }).catch(() => {});
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles((event) => {
    for (const uri of event.files) {
      const file = relativeUri(uri);
      if (!file || consumeSuppressed(file)) continue;
      documents.delete(file);
      void queueFileOperation({ type: 'file:delete', path: file }).catch(() => {});
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidRenameFiles((event) => {
    for (const change of event.files) {
      const oldPath = relativeUri(change.oldUri);
      const newPath = relativeUri(change.newUri);
      if (!oldPath || !newPath || consumeSuppressed(oldPath) || consumeSuppressed(newPath)) continue;
      const document = documents.get(oldPath);
      documents.delete(oldPath);
      if (document) documents.set(newPath, document);
      void queueFileOperation({ type: 'file:rename', oldPath, newPath }).catch(() => {});
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    const file = relativePath(event.document);
    if (!file || applyingRemote.has(event.document)) return;
    clearTimeout(pendingChanges.get(file));
    pendingChanges.set(file, setTimeout(() => {
      pendingChanges.delete(file);
      void post({ type: 'document:change', path: file, text: event.document.getText() }).catch(() => {});
    }, 75));
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    const file = relativePath(event.textEditor.document);
    if (!file || applyingRemote.has(event.textEditor.document)) return;
    clearTimeout(pendingSelections.get(file));
    pendingSelections.set(file, setTimeout(() => {
      pendingSelections.delete(file);
      const selections = event.selections.map((selection) => ({
        anchor: event.textEditor.document.offsetAt(selection.anchor),
        active: event.textEditor.document.offsetAt(selection.active)
      }));
      void post({ type: 'cursor:update', path: file, selections }).catch(() => {});
    }, 50));
  }));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    for (const entry of remoteCursors.values()) renderCursor(entry);
  }));
  void poll();
}

async function deactivate() {
  disposed = true;
  await fileOperationWrite.catch(() => {});
  extensionContext = null;
  sessionRole = null;
  for (const timer of pendingChanges.values()) clearTimeout(timer);
  for (const timer of pendingSelections.values()) clearTimeout(timer);
  pendingChanges.clear();
  pendingSelections.clear();
  for (const timer of suppressedFileEvents.values()) clearTimeout(timer);
  suppressedFileEvents.clear();
  for (const userId of [...remoteCursors.keys()]) removeCursor(userId);
}

module.exports = { activate, deactivate };
