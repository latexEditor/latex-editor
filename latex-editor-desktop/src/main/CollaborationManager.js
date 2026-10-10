let DefaultWebSocket = global.WebSocket;
try { DefaultWebSocket ||= require('undici').WebSocket; } catch {}

class CollaborationManager {
  constructor({ auth, cloud, onChange = () => {}, WebSocketImpl = DefaultWebSocket }) {
    this.auth = auth;
    this.cloud = cloud;
    this.onChange = onChange;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.project = null;
    this.enabled = false;
    this.connection = 'offline';
    this.participants = [];
    this.error = null;
    this.generation = 0;
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
    const socket = this.socket;
    this.socket = null;
    this.project = null;
    this.enabled = false;
    this.connection = 'offline';
    this.participants = [];
    this.error = null;
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
    this.connection = 'connecting';
    this.error = null;
    this.changed();

    let socket;
    try {
      socket = new this.WebSocketImpl(url.toString(), this.auth.webSocketProtocols());
    } catch (error) {
      if (generation === this.generation) {
        this.connection = 'error';
        this.error = error.message;
        this.changed();
      }
      return this.status();
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.connection = 'online';
      this.error = null;
      this.changed();
    });
    socket.addEventListener('message', (event) => {
      if (generation !== this.generation || socket !== this.socket || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data);
        if (Array.isArray(message.participants) && ['welcome', 'presence'].includes(message.type)) {
          this.participants = message.participants;
          this.changed();
        }
      } catch {}
    });
    socket.addEventListener('close', (event) => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.socket = null;
      this.connection = event.code === 4003 ? 'revoked' : 'offline';
      this.participants = [];
      this.error = event.code === 4003 ? 'Quyền truy cập project đã bị thu hồi.' : null;
      this.changed();
    });
    socket.addEventListener('error', () => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.connection = 'error';
      this.error = 'Không kết nối được phòng cộng tác.';
      this.changed();
    });
    return this.status();
  }

  dispose() { this.close(); }
}

module.exports = { CollaborationManager };
