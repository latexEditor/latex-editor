let DefaultWebSocket = global.WebSocket;
try { DefaultWebSocket ||= require('undici').WebSocket; } catch {}
const { randomUUID } = require('node:crypto');
const Y = require('yjs');

const MAX_DOCUMENT_CHARS = 1024 * 1024;

function encodeUpdate(update) { return Buffer.from(update).toString('base64'); }
function decodeUpdate(update) { return new Uint8Array(Buffer.from(update, 'base64')); }

class CollaborationManager {
  constructor({
    auth, cloud, onChange = () => {}, onEditorMessage = () => {}, WebSocketImpl = DefaultWebSocket,
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, reconnectBaseMs = 1000
  }) {
    this.auth = auth;
    this.cloud = cloud;
    this.onChange = onChange;
    this.WebSocketImpl = WebSocketImpl;
    this.onEditorMessage = onEditorMessage;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.reconnectBaseMs = reconnectBaseMs;
    this.socket = null;
    this.project = null;
    this.enabled = false;
    this.connection = 'offline';
    this.participants = [];
    this.error = null;
    this.generation = 0;
    this.documents = new Map();
    this.outbox = [];
    this.self = null;
    this.url = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.pendingResets = new Map();
    this.latestCursors = new Map();
  }

  status() {
    return {
      connection: this.connection,
      enabled: this.enabled,
      participants: this.participants.map((participant) => ({ ...participant })),
      error: this.error
    };
  }

  changed() { this.onChange(this.status()); }

  close() {
    this.generation += 1;
    if (this.reconnectTimer) this.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    for (const participant of this.participants) {
      this.onEditorMessage({ type: 'cursor:leave', userId: participant.id });
    }
    this.socket = null;
    this.project = null;
    this.enabled = false;
    this.connection = 'offline';
    this.participants = [];
    this.error = null;
    this.documents.clear();
    this.latestCursors.clear();
    this.outbox = [];
    this.self = null;
    this.url = null;
    this.reconnectAttempts = 0;
    for (const reset of this.pendingResets.values()) {
      this.clearTimeout(reset.timer);
      reset.reject(new Error('Phiên cộng tác đã đóng trước khi reset draft hoàn tất.'));
    }
    this.pendingResets.clear();
    try { socket?.close(1000, 'Project closed'); } catch {}
    this.changed();
  }

  async open(project) {
    this.close();
    if (!project || !this.auth.status().signedIn) return this.status();
    if (!this.WebSocketImpl) {
      this.error = 'Runtime chưa hỗ trợ WebSocket.';
      this.changed();
      return this.status();
    }

    const generation = this.generation;
    const metadata = await this.cloud.readMetadata(project);
    if (generation !== this.generation || !metadata || metadata.apiUrl !== this.auth.apiUrl) return this.status();

    const url = new URL(`/v1/projects/${metadata.id}/collaboration`, this.auth.apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.project = project;
    this.enabled = true;
    this.error = null;
    this.url = url.toString();
    this.#connect(generation);
    return this.status();
  }

  #connect(generation) {
    if (generation !== this.generation || !this.enabled || !this.url) return;
    this.connection = this.reconnectAttempts ? 'reconnecting' : 'connecting';
    this.changed();
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url, this.auth.webSocketProtocols());
    } catch (error) {
      if (generation === this.generation) {
        this.error = error.message;
        this.changed();
        this.#scheduleReconnect(generation);
      }
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.connection = 'online';
      this.error = null;
      this.reconnectAttempts = 0;
      for (const message of this.outbox.splice(0)) socket.send(JSON.stringify(message));
      this.changed();
    });
    socket.addEventListener('message', (event) => {
      if (generation !== this.generation || socket !== this.socket || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'welcome') {
          this.self = message.self || null;
          this.onEditorMessage({ type: 'session', role: this.self?.role || null });
          this.onEditorMessage({ type: 'documents:rescan' });
        }
        if (Array.isArray(message.participants) && ['welcome', 'presence'].includes(message.type)) {
          this.participants = message.participants;
          this.changed();
        }
        if (message.type === 'presence' && message.action === 'leave' && message.userId
          && !this.participants.some((participant) => participant.id === message.userId)) {
          this.latestCursors.delete(message.userId);
          this.onEditorMessage({ type: 'cursor:leave', userId: message.userId });
        }
        if (message.type === 'document:state') this.#receiveDocumentState(message);
        if (message.type === 'document:update') this.#receiveDocumentUpdate(message);
        if (message.type === 'document:replace') this.#receiveDocumentReplace(message);
        if (message.type === 'document:missing' && this.#validPath(message.path)) {
          this.documents.delete(message.path);
          this.onEditorMessage({ type: 'file:delete', path: message.path });
        }
        if (message.type === 'filesystem:state' && Array.isArray(message.entries)) {
          const entries = message.entries.slice(0, 5000).filter((entry) => entry
            && this.#validPath(entry.path) && typeof entry.deleted === 'boolean');
          this.onEditorMessage({ type: 'filesystem:state', revision: message.revision, entries });
        }
        if (message.type === 'file:create' && this.#validPath(message.path)) {
          this.onEditorMessage({ type: 'file:create', path: message.path });
        }
        if (message.type === 'file:delete' && this.#validPath(message.path)) {
          this.documents.delete(message.path);
          this.onEditorMessage({ type: 'file:delete', path: message.path });
        }
        if (message.type === 'file:rename' && this.#validPath(message.oldPath) && this.#validPath(message.newPath)) {
          const document = this.documents.get(message.oldPath);
          this.documents.delete(message.oldPath);
          if (document) {
            document.path = message.newPath;
            this.documents.set(message.newPath, document);
          }
          this.onEditorMessage({ type: 'file:rename', oldPath: message.oldPath, newPath: message.newPath });
        }
        if (message.type === 'file:ack' && this.#validOperationId(message.operationId)) {
          this.onEditorMessage({
            type: 'file:ack', operationId: message.operationId, accepted: message.accepted !== false,
            code: typeof message.code === 'string' ? message.code : null, revision: message.revision
          });
        }
        if (['filesystem:reset:ack', 'document:reset:ack'].includes(message.type)
          && this.#validOperationId(message.requestId)) this.#ackReset(message.requestId);
        if (message.type === 'error' && this.#validOperationId(message.requestId)) {
          const reset = this.pendingResets.get(message.requestId);
          if (reset) {
            this.pendingResets.delete(message.requestId);
            this.clearTimeout(reset.timer);
            reset.reject(new Error(`Worker từ chối reset draft: ${message.code || 'unknown_error'}.`));
          }
        }
        if (message.type === 'cursor:update' && message.user?.id) {
          this.latestCursors.set(message.user.id, {
            path: message.path,
            selections: message.selections,
            user: message.user
          });
          this.onEditorMessage({
            type: 'cursor:remote', path: message.path,
            selections: message.selections, user: message.user
          });
        }
      } catch {}
    });
    socket.addEventListener('close', (event) => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.socket = null;
      for (const participant of this.participants) {
        this.onEditorMessage({ type: 'cursor:leave', userId: participant.id });
      }
      this.participants = [];
      this.documents.clear();
      this.latestCursors.clear();
      this.outbox = this.outbox.filter((message) => ['file:create', 'file:delete', 'file:rename'].includes(message.type));
      this.self = null;
      if (event.code === 4003) {
        this.connection = 'revoked';
        this.enabled = false;
        this.error = 'Quyền truy cập project đã bị thu hồi.';
        this.changed();
      } else {
        this.error = 'Mất kết nối; đang tự kết nối lại.';
        this.#scheduleReconnect(generation);
      }
    });
    socket.addEventListener('error', () => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.error = 'Không kết nối được phòng cộng tác.';
      this.changed();
    });
  }

  #scheduleReconnect(generation) {
    if (generation !== this.generation || !this.enabled || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    this.connection = 'reconnecting';
    const delay = Math.min(this.reconnectBaseMs * (2 ** (this.reconnectAttempts - 1)), 30_000);
    this.changed();
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect(generation);
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  send(message) {
    if (!this.enabled) return false;
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
    else this.outbox.push(message);
    return true;
  }

  resetCapability(project) {
    if (!this.enabled || project !== this.project) return { required: false, ready: true, participants: 0 };
    if (this.connection !== 'online' || this.socket?.readyState !== 1) {
      return { required: true, ready: false, participants: this.participants.length, error: 'Cần kết nối phòng cộng tác trước khi khôi phục snapshot.' };
    }
    if (!['owner', 'editor'].includes(this.self?.role)) {
      return { required: true, ready: false, participants: this.participants.length, error: 'Chỉ owner hoặc editor mới được khôi phục snapshot vào draft cộng tác.' };
    }
    return { required: true, ready: true, participants: this.participants.length };
  }

  resetDrafts(project) {
    const capability = this.resetCapability(project);
    if (!capability.required) return Promise.resolve({ skipped: true });
    if (!capability.ready) return Promise.reject(new Error(capability.error));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = this.setTimeout(() => {
        this.pendingResets.delete(requestId);
        reject(new Error('Worker không xác nhận reset draft trong thời gian cho phép.'));
      }, 60_000);
      timer?.unref?.();
      this.pendingResets.set(requestId, { resolve, reject, timer, expected: null, acknowledged: 0 });
      this.onEditorMessage({ type: 'draft:reset-request', requestId });
    });
  }

  handleEditorMessage(message) {
    if (!this.enabled) return false;
    if (message?.type === 'draft:reset:begin' && this.#validOperationId(message.requestId)) {
      if (!Array.isArray(message.paths) || message.paths.length > 5000 || message.paths.some((path) => !this.#validPath(path))) return false;
      return this.send({ type: 'filesystem:reset', requestId: message.requestId, paths: [...new Set(message.paths)] });
    }
    if (message?.type === 'draft:reset:document' && this.#validOperationId(message.requestId)) {
      if (!this.#validPath(message.path) || typeof message.text !== 'string' || message.text.length > MAX_DOCUMENT_CHARS) return false;
      const state = this.#newDocumentState(message.path, message.text, true);
      this.documents.set(message.path, state);
      return this.send({
        type: 'document:reset', requestId: message.requestId, path: message.path,
        update: encodeUpdate(Y.encodeStateAsUpdate(state.doc))
      });
    }
    if (message?.type === 'draft:reset:end' && this.#validOperationId(message.requestId)) {
      const reset = this.pendingResets.get(message.requestId);
      if (!reset || !Number.isSafeInteger(message.count) || message.count < 0 || message.count > 5000) return false;
      reset.expected = message.count + 1;
      this.#completeReset(message.requestId);
      return true;
    }
    if (message?.type === 'draft:reset:failed' && this.#validOperationId(message.requestId)) {
      const reset = this.pendingResets.get(message.requestId);
      if (!reset) return false;
      this.pendingResets.delete(message.requestId);
      this.clearTimeout(reset.timer);
      reset.reject(new Error(typeof message.error === 'string' ? message.error : 'Không đọc được snapshot từ ổ đĩa.'));
      return true;
    }
    if (message?.type === 'filesystem:snapshot') {
      if (!Array.isArray(message.paths) || message.paths.length > 5000 || message.paths.some((path) => !this.#validPath(path))) return false;
      return this.send({ type: 'manifest:subscribe', paths: [...new Set(message.paths)] });
    }
    if (message?.type === 'file:create' || message?.type === 'file:delete') {
      if (!this.#validPath(message.path) || !this.#validOperationId(message.operationId) || this.self?.role === 'viewer') return false;
      return this.send({ type: message.type, path: message.path, operationId: message.operationId });
    }
    if (message?.type === 'file:rename') {
      if (!this.#validPath(message.oldPath) || !this.#validPath(message.newPath)
        || !this.#validOperationId(message.operationId)
        || message.oldPath === message.newPath || this.self?.role === 'viewer') return false;
      const document = this.documents.get(message.oldPath);
      this.documents.delete(message.oldPath);
      if (document) {
        document.path = message.newPath;
        this.documents.set(message.newPath, document);
      }
      return this.send({
        type: 'file:rename', oldPath: message.oldPath, newPath: message.newPath, operationId: message.operationId
      });
    }
    if (message?.type === 'cursor:update') {
      if (!this.#validPath(message.path) || !Array.isArray(message.selections) || message.selections.length > 20) return false;
      const selections = message.selections.map((selection) => ({
        anchor: Number(selection.anchor), active: Number(selection.active)
      }));
      if (selections.some((selection) => !Number.isSafeInteger(selection.anchor) || selection.anchor < 0
        || !Number.isSafeInteger(selection.active) || selection.active < 0 || selection.anchor > MAX_DOCUMENT_CHARS
        || selection.active > MAX_DOCUMENT_CHARS)) return false;
      return this.send({ type: 'cursor:update', path: message.path, selections });
    }
    if (!message || typeof message.path !== 'string' || typeof message.text !== 'string') return false;
    if (!['document:open', 'document:change'].includes(message.type)) return false;
    if (message.text.length > MAX_DOCUMENT_CHARS || !this.#validPath(message.path)) return false;
    let state = this.documents.get(message.path);
    if (!state) {
      state = this.#newDocumentState(message.path, '', false);
      state.localText = message.text;
      this.documents.set(message.path, state);
      this.send({ type: 'document:subscribe', path: message.path });
      return true;
    }
    state.localText = message.text;
    if (!state.ready) return true;
    if (this.self?.role === 'viewer') {
      this.onEditorMessage({ type: 'document:remote', path: message.path, text: state.text.toString() });
      return false;
    }
    this.#replaceText(state, message.text, 'editor');
    return true;
  }

  jumpToParticipant(userId) {
    const cursor = this.latestCursors.get(userId) || null;
    this.onEditorMessage({
      type: 'cursor:jump',
      userId,
      cursor
    });
    return true;
  }

  #validPath(value) {
    return value.length > 0 && value.length <= 500 && !value.startsWith('/')
      && !value.split('/').some((part) => !part || part === '.' || part === '..');
  }

  #validOperationId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(value);
  }

  #newDocumentState(path, value = '', ready = false) {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    if (value) text.insert(0, value);
    const state = { path, doc, text, localText: value, ready };
    doc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      this.send({ type: origin === 'seed' ? 'document:seed' : 'document:update', path: state.path, update: encodeUpdate(update) });
    });
    return state;
  }

  #ackReset(requestId) {
    const reset = this.pendingResets.get(requestId);
    if (!reset) return;
    reset.acknowledged += 1;
    this.#completeReset(requestId);
  }

  #completeReset(requestId) {
    const reset = this.pendingResets.get(requestId);
    if (!reset || reset.expected === null || reset.acknowledged < reset.expected) return;
    this.pendingResets.delete(requestId);
    this.clearTimeout(reset.timer);
    reset.resolve({ reset: true, documents: reset.expected - 1 });
  }

  #replaceText(state, value, origin) {
    const current = state.text.toString();
    if (current === value) return;
    let prefix = 0;
    while (prefix < current.length && prefix < value.length && current[prefix] === value[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < current.length - prefix && suffix < value.length - prefix
      && current[current.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix += 1;
    state.doc.transact(() => {
      const removed = current.length - prefix - suffix;
      if (removed) state.text.delete(prefix, removed);
      const inserted = value.slice(prefix, value.length - suffix);
      if (inserted) state.text.insert(prefix, inserted);
    }, origin);
  }

  #receiveDocumentState(message) {
    const state = this.documents.get(message.path);
    if (!state || state.ready) return;
    if (message.update) Y.applyUpdate(state.doc, decodeUpdate(message.update), 'remote');
    state.ready = true;
    if (!message.update && this.self?.role !== 'viewer') this.#replaceText(state, state.localText, 'seed');
    this.onEditorMessage({ type: 'document:remote', path: message.path, text: state.text.toString() });
  }

  #receiveDocumentUpdate(message) {
    const state = this.documents.get(message.path);
    if (!state || typeof message.update !== 'string') return;
    try {
      Y.applyUpdate(state.doc, decodeUpdate(message.update), 'remote');
      state.ready = true;
      this.onEditorMessage({ type: 'document:remote', path: message.path, text: state.text.toString() });
    } catch {}
  }

  #receiveDocumentReplace(message) {
    if (!this.#validPath(message.path) || typeof message.update !== 'string') return;
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, decodeUpdate(message.update), 'remote');
      const state = this.#newDocumentState(message.path, doc.getText('content').toString(), true);
      this.documents.set(message.path, state);
      this.onEditorMessage({ type: 'document:remote', path: message.path, text: state.text.toString() });
    } catch {}
  }

  dispose() { this.close(); }
}

module.exports = { CollaborationManager };
