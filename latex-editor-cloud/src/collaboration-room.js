const MAX_MESSAGE_BYTES = 16 * 1024;

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
