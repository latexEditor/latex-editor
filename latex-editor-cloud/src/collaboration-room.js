import * as Y from 'yjs';

const MAX_MESSAGE_BYTES = 1536 * 1024;
const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 5000;
const DOCUMENT_PREFIX = 'document:';
const MANIFEST_KEY = 'manifest:v1';
const MAX_RECENT_OPERATIONS = 256;

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.startsWith('/')
    && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function validOperationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(value);
}

function encodeUpdate(update) {
  let binary = '';
  for (let offset = 0; offset < update.length; offset += 0x8000) {
    binary += String.fromCharCode(...update.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeUpdate(value) {
  if (typeof value !== 'string' || value.length > MAX_UPDATE_BYTES * 2) throw new Error('invalid_update');
  const binary = atob(value);
  if (binary.length > MAX_UPDATE_BYTES) throw new Error('update_too_large');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function connectionState(socket) {
  try {
    return socket.deserializeAttachment() || null;
  } catch {
    return null;
  }
}

function publicUser(state) {
  return {
    id: state.userId,
    name: state.name,
    avatarUrl: state.avatarUrl || null,
    role: state.role,
    joinedAt: state.joinedAt
  };
}

export class ProjectCollaborationRoom {
  constructor(state) {
    this.state = state;
  }

  sockets() {
    return this.state.getWebSockets();
  }

  participants(excludedSocket = null) {
    const users = new Map();
    for (const socket of this.sockets()) {
      if (socket === excludedSocket) continue;
      const state = connectionState(socket);
      if (!state) continue;
      const existing = users.get(state.userId);
      if (existing) existing.connections += 1;
      else users.set(state.userId, { ...publicUser(state), connections: 1 });
    }
    return [...users.values()].sort((left, right) => left.joinedAt - right.joinedAt);
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(message, excludedSocket = null) {
    for (const socket of this.sockets()) {
      if (socket !== excludedSocket) this.send(socket, message);
    }
  }

  async document(path) {
    const saved = await this.state.storage.get(DOCUMENT_PREFIX + path);
    const doc = new Y.Doc();
    if (saved) Y.applyUpdate(doc, new Uint8Array(saved));
    return { doc, saved: Boolean(saved) };
  }

  async manifest() {
    const saved = await this.state.storage.get(MANIFEST_KEY);
    if (!saved) return { revision: 0, entries: {}, operations: {}, pendingDraftDeletes: [] };
    let manifest;
    try {
      const value = typeof saved === 'string' ? saved : new TextDecoder().decode(new Uint8Array(saved));
      manifest = JSON.parse(value);
      if (!manifest || !Number.isSafeInteger(manifest.revision) || !manifest.entries) return { revision: 0, entries: {}, operations: {}, pendingDraftDeletes: [] };
    } catch {
      return { revision: 0, entries: {}, operations: {}, pendingDraftDeletes: [] };
    }
    manifest.operations = manifest.operations && typeof manifest.operations === 'object' ? manifest.operations : {};
    manifest.pendingDraftDeletes = Array.isArray(manifest.pendingDraftDeletes)
      ? [...new Set(manifest.pendingDraftDeletes.filter(validPath))].slice(0, MAX_MANIFEST_ENTRIES)
      : [];
    if (manifest.pendingDraftDeletes.length) await this.cleanupDrafts(manifest);
    return manifest;
  }

  queueDraftCleanup(manifest, paths) {
    manifest.pendingDraftDeletes = [...new Set([...(manifest.pendingDraftDeletes || []), ...paths.filter(validPath)])]
      .slice(-MAX_MANIFEST_ENTRIES);
  }

  async cleanupDrafts(manifest) {
    const paths = [...new Set(manifest.pendingDraftDeletes || [])];
    for (let offset = 0; offset < paths.length; offset += 128) {
      const pending = paths.slice(offset, offset + 128)
        .map((path) => this.state.storage.delete(DOCUMENT_PREFIX + path));
      await Promise.all(pending);
    }
    manifest.pendingDraftDeletes = [];
    await this.saveManifest(manifest);
  }

  rememberOperation(manifest, operationId) {
    if (!validOperationId(operationId)) return;
    manifest.operations ||= {};
    manifest.operations[operationId] = manifest.revision;
    const ids = Object.keys(manifest.operations);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_RECENT_OPERATIONS))) delete manifest.operations[id];
  }

  acknowledgeFile(socket, event, manifest, accepted = true, code = null) {
    this.send(socket, {
      type: 'file:ack', operationId: validOperationId(event.operationId) ? event.operationId : null,
      revision: manifest.revision, accepted, ...(code ? { code } : {})
    });
  }

  async saveManifest(manifest) {
    await this.state.storage.put(MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(manifest)));
  }

  manifestState(manifest) {
    return {
      type: 'filesystem:state', revision: manifest.revision,
      entries: Object.entries(manifest.entries).map(([path, entry]) => ({ path, deleted: Boolean(entry.deleted) }))
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/presence' && request.method === 'GET') {
      return json({ participants: this.participants() });
    }

    if (url.pathname === '/disconnect' && request.method === 'POST') {
      const userId = request.headers.get('X-Collaboration-User-Id');
      if (!userId) return json({ error: 'Thiếu thành viên cần ngắt kết nối.' }, 400);
      let disconnected = 0;
      for (const socket of this.sockets()) {
        if (connectionState(socket)?.userId !== userId) continue;
        disconnected += 1;
        try { socket.close(4003, 'Project access revoked'); } catch {}
      }
      if (disconnected) this.broadcast({ type: 'presence', action: 'leave', userId, participants: this.participants() });
      return json({ disconnected });
    }

    if (url.pathname === '/destroy' && request.method === 'POST') {
      for (const socket of this.sockets()) {
        try { socket.close(4003, 'Project deleted'); } catch {}
      }
      await this.state.storage.deleteAll();
      return json({ destroyed: true });
    }

    if (url.pathname !== '/connect' || request.method !== 'GET') return json({ error: 'Không tìm thấy phòng cộng tác.' }, 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Cần kết nối WebSocket.' }, 426);

    const identity = {
      userId: request.headers.get('X-Collaboration-User-Id'),
      name: request.headers.get('X-Collaboration-User-Name') || 'Thành viên',
      avatarUrl: request.headers.get('X-Collaboration-User-Avatar') || null,
      role: request.headers.get('X-Collaboration-Role'),
      joinedAt: Date.now(),
      connectionId: crypto.randomUUID()
    };
    if (!identity.userId || !['owner', 'editor', 'viewer'].includes(identity.role)) return json({ error: 'Danh tính cộng tác không hợp lệ.' }, 403);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment(identity);
    this.state.acceptWebSocket(server);

    this.send(server, { type: 'welcome', self: publicUser(identity), participants: this.participants() });
    this.broadcast({ type: 'presence', action: 'join', user: publicUser(identity), participants: this.participants() }, server);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'latex-editor-v1' }
    });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'Message too large');
      return;
    }

    let event;
    try { event = JSON.parse(message); } catch {
      this.send(socket, { type: 'error', code: 'invalid_json' });
      return;
    }

    if (event?.type === 'ping') {
      this.send(socket, { type: 'pong', at: Date.now() });
      return;
    }
    if (event?.type === 'presence:request') {
      this.send(socket, { type: 'presence', action: 'snapshot', participants: this.participants() });
      return;
    }
    if (event?.type === 'manifest:subscribe' && Array.isArray(event.paths)) {
      const identity = connectionState(socket);
      const paths = [...new Set(event.paths.filter(validPath))].slice(0, 5000);
      let manifest = await this.manifest();
      if (!manifest.revision && identity && identity.role !== 'viewer') {
        manifest = {
          revision: 1,
          entries: Object.fromEntries(paths.map((path) => [path, { deleted: false, changedAt: Date.now() }])),
          operations: {}, pendingDraftDeletes: []
        };
        await this.saveManifest(manifest);
      }
      this.send(socket, this.manifestState(manifest));
      return;
    }
    if (event?.type === 'file:create' && validPath(event.path)) {
      const identity = connectionState(socket);
      if (!identity || identity.role === 'viewer') {
        this.acknowledgeFile(socket, event, { revision: 0 }, false, 'read_only');
        return;
      }
      const manifest = await this.manifest();
      if (validOperationId(event.operationId) && Object.hasOwn(manifest.operations, event.operationId)) {
        this.acknowledgeFile(socket, event, manifest);
        return;
      }
      if (manifest.entries[event.path]?.deleted === false) {
        this.rememberOperation(manifest, event.operationId);
        await this.saveManifest(manifest);
        this.acknowledgeFile(socket, event, manifest);
        return;
      }
      if (!manifest.entries[event.path] && Object.keys(manifest.entries).length >= MAX_MANIFEST_ENTRIES) {
        this.acknowledgeFile(socket, event, manifest, false, 'manifest_full');
        return;
      }
      manifest.revision += 1;
      manifest.entries[event.path] = { deleted: false, changedAt: Date.now() };
      this.rememberOperation(manifest, event.operationId);
      await this.saveManifest(manifest);
      this.broadcast({ type: 'file:create', path: event.path, revision: manifest.revision }, socket);
      this.acknowledgeFile(socket, event, manifest);
      return;
    }
    if (event?.type === 'file:delete' && validPath(event.path)) {
      const identity = connectionState(socket);
      if (!identity || identity.role === 'viewer') {
        this.acknowledgeFile(socket, event, { revision: 0 }, false, 'read_only');
        return;
      }
      const manifest = await this.manifest();
      if (validOperationId(event.operationId) && Object.hasOwn(manifest.operations, event.operationId)) {
        this.acknowledgeFile(socket, event, manifest);
        return;
      }
      if (manifest.entries[event.path]?.deleted === true) {
        this.rememberOperation(manifest, event.operationId);
        await this.saveManifest(manifest);
        this.acknowledgeFile(socket, event, manifest);
        return;
      }
      manifest.revision += 1;
      manifest.entries[event.path] = { deleted: true, changedAt: Date.now() };
      this.rememberOperation(manifest, event.operationId);
      this.queueDraftCleanup(manifest, [event.path]);
      await this.saveManifest(manifest);
      await this.cleanupDrafts(manifest);
      this.broadcast({ type: 'file:delete', path: event.path, revision: manifest.revision }, socket);
      this.acknowledgeFile(socket, event, manifest);
      return;
    }
    if (event?.type === 'file:rename' && validPath(event.oldPath) && validPath(event.newPath)
      && event.oldPath !== event.newPath) {
      const identity = connectionState(socket);
      if (!identity || identity.role === 'viewer') {
        this.acknowledgeFile(socket, event, { revision: 0 }, false, 'read_only');
        return;
      }
      const manifest = await this.manifest();
      if (validOperationId(event.operationId) && Object.hasOwn(manifest.operations, event.operationId)) {
        this.acknowledgeFile(socket, event, manifest);
        return;
      }
      if (manifest.entries[event.oldPath]?.deleted === true
        && manifest.entries[event.newPath]?.deleted === false) {
        this.rememberOperation(manifest, event.operationId);
        await this.saveManifest(manifest);
        this.acknowledgeFile(socket, event, manifest);
        return;
      }
      if (manifest.entries[event.oldPath]?.deleted === true) {
        this.acknowledgeFile(socket, event, manifest, false, 'file_missing');
        return;
      }
      if (manifest.entries[event.newPath]?.deleted === false) {
        this.acknowledgeFile(socket, event, manifest, false, 'file_exists');
        return;
      }
      if (!manifest.entries[event.newPath] && Object.keys(manifest.entries).length >= MAX_MANIFEST_ENTRIES) {
        this.acknowledgeFile(socket, event, manifest, false, 'manifest_full');
        return;
      }
      manifest.revision += 1;
      const changedAt = Date.now();
      manifest.entries[event.oldPath] = { deleted: true, changedAt };
      manifest.entries[event.newPath] = { deleted: false, changedAt };
      this.rememberOperation(manifest, event.operationId);
      const existing = await this.state.storage.get(DOCUMENT_PREFIX + event.oldPath);
      if (existing) await this.state.storage.put(DOCUMENT_PREFIX + event.newPath, existing);
      this.queueDraftCleanup(manifest, [event.oldPath]);
      await this.saveManifest(manifest);
      await this.cleanupDrafts(manifest);
      this.broadcast({
        type: 'file:rename', oldPath: event.oldPath, newPath: event.newPath, revision: manifest.revision
      }, socket);
      this.acknowledgeFile(socket, event, manifest);
      return;
    }
    if (event?.type === 'filesystem:reset' && validOperationId(event.requestId) && Array.isArray(event.paths)) {
      const identity = connectionState(socket);
      if (!identity || identity.role === 'viewer') {
        this.send(socket, { type: 'error', code: 'read_only', requestId: event.requestId });
        return;
      }
      const paths = [...new Set(event.paths.filter(validPath))];
      if (paths.length !== event.paths.length || paths.length > MAX_MANIFEST_ENTRIES) {
        this.send(socket, { type: 'error', code: 'invalid_manifest', requestId: event.requestId });
        return;
      }
      const active = new Set(paths);
      const manifest = await this.manifest();
      const changedAt = Date.now();
      const deletedPaths = [];
      for (const [path, entry] of Object.entries(manifest.entries)) {
        if (!entry.deleted && !active.has(path)) {
          manifest.entries[path] = { deleted: true, changedAt };
          deletedPaths.push(path);
        }
      }
      for (const path of paths) manifest.entries[path] = { deleted: false, changedAt };
      manifest.revision += 1;
      this.queueDraftCleanup(manifest, deletedPaths);
      await this.saveManifest(manifest);
      await this.cleanupDrafts(manifest);
      this.broadcast(this.manifestState(manifest), socket);
      this.send(socket, { type: 'filesystem:reset:ack', requestId: event.requestId, revision: manifest.revision });
      return;
    }
    if (event?.type === 'document:reset' && validOperationId(event.requestId) && validPath(event.path)) {
      const identity = connectionState(socket);
      if (!identity || identity.role === 'viewer') {
        this.send(socket, { type: 'error', code: 'read_only', requestId: event.requestId });
        return;
      }
      try {
        const manifest = await this.manifest();
        if (manifest.entries[event.path]?.deleted) throw new Error('document_deleted');
        const update = decodeUpdate(event.update);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, update);
        const state = Y.encodeStateAsUpdate(doc);
        if (state.byteLength > MAX_UPDATE_BYTES) throw new Error('document_too_large');
        await this.state.storage.put(DOCUMENT_PREFIX + event.path, state);
        this.broadcast({ type: 'document:replace', path: event.path, update: encodeUpdate(state) }, socket);
        this.send(socket, { type: 'document:reset:ack', requestId: event.requestId, path: event.path });
      } catch (error) {
        this.send(socket, { type: 'error', code: error.message || 'invalid_update', requestId: event.requestId });
      }
      return;
    }
    if (event?.type === 'cursor:update' && validPath(event.path) && Array.isArray(event.selections)
      && event.selections.length <= 20) {
      const identity = connectionState(socket);
      const selections = event.selections.map((selection) => ({
        anchor: Number(selection.anchor), active: Number(selection.active)
      }));
      const validSelections = selections.every((selection) => Number.isSafeInteger(selection.anchor)
        && selection.anchor >= 0 && selection.anchor <= MAX_UPDATE_BYTES
        && Number.isSafeInteger(selection.active) && selection.active >= 0 && selection.active <= MAX_UPDATE_BYTES);
      if (!identity || !validSelections) {
        this.send(socket, { type: 'error', code: 'invalid_cursor' });
        return;
      }
      this.broadcast({
        type: 'cursor:update', path: event.path,
        selections, user: publicUser(identity)
      }, socket);
      return;
    }
    if (event?.type === 'document:subscribe' && validPath(event.path)) {
      const manifest = await this.manifest();
      if (manifest.entries[event.path]?.deleted) {
        this.send(socket, { type: 'document:missing', path: event.path });
        return;
      }
      const { doc, saved } = await this.document(event.path);
      this.send(socket, {
        type: 'document:state', path: event.path,
        update: saved ? encodeUpdate(Y.encodeStateAsUpdate(doc)) : null
      });
      return;
    }
    if (event?.type === 'document:update' && validPath(event.path)) {
      const identity = connectionState(socket);
      if (!identity || identity.role === 'viewer') {
        this.send(socket, { type: 'error', code: 'read_only' });
        return;
      }
      try {
        const manifest = await this.manifest();
        if (manifest.entries[event.path]?.deleted) throw new Error('document_deleted');
        const update = decodeUpdate(event.update);
        const { doc } = await this.document(event.path);
        Y.applyUpdate(doc, update);
        const state = Y.encodeStateAsUpdate(doc);
        if (state.byteLength > MAX_UPDATE_BYTES) throw new Error('document_too_large');
        await this.state.storage.put(DOCUMENT_PREFIX + event.path, state);
        this.broadcast({ type: 'document:update', path: event.path, update: encodeUpdate(update) }, socket);
      } catch (error) {
        this.send(socket, { type: 'error', code: error.message || 'invalid_update' });
      }
      return;
    }
    if (event?.type === 'document:seed' && validPath(event.path)) {
      const identity = connectionState(socket);
      if (!identity || identity.role === 'viewer') {
        this.send(socket, { type: 'error', code: 'read_only' });
        return;
      }
      try {
        const manifest = await this.manifest();
        if (manifest.entries[event.path]?.deleted) throw new Error('document_deleted');
        const existing = await this.state.storage.get(DOCUMENT_PREFIX + event.path);
        if (existing) {
          this.send(socket, { type: 'document:state', path: event.path, update: encodeUpdate(new Uint8Array(existing)) });
          return;
        }
        const update = decodeUpdate(event.update);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, update);
        const state = Y.encodeStateAsUpdate(doc);
        if (state.byteLength > MAX_UPDATE_BYTES) throw new Error('document_too_large');
        await this.state.storage.put(DOCUMENT_PREFIX + event.path, state);
        this.broadcast({ type: 'document:update', path: event.path, update: encodeUpdate(update) }, socket);
      } catch (error) {
        this.send(socket, { type: 'error', code: error.message || 'invalid_update' });
      }
      return;
    }
    this.send(socket, { type: 'error', code: 'unsupported_event' });
  }

  async webSocketClose(socket) {
    const identity = connectionState(socket);
    if (identity) this.broadcast({ type: 'presence', action: 'leave', userId: identity.userId, participants: this.participants(socket) }, socket);
  }

  async webSocketError(socket) {
    const identity = connectionState(socket);
    if (identity) this.broadcast({ type: 'presence', action: 'leave', userId: identity.userId, participants: this.participants(socket) }, socket);
  }
}
