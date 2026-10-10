const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

class PresenceWindowManager {
  constructor(parent, getData) {
    this.parent = parent;
    this.getData = getData;
    this.window = null;
    this.blurTimer = null;
  }

  close() {
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = null;
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }

  async toggle(anchor = {}) {
    if (this.window && !this.window.isDestroyed()) {
      this.close();
      return false;
    }
    if (!this.parent || this.parent.isDestroyed()) return false;
    const values = [anchor.left, anchor.right, anchor.bottom];
    if (!values.every(Number.isFinite)) return false;

    const data = this.getData();
    const participants = Array.isArray(data.participants) ? data.participants : [];
    const width = 300;
    const height = Math.min(340, 72 + Math.max(1, participants.length) * 52);
    const contentBounds = this.parent.getContentBounds();
    const requested = {
      x: Math.round(contentBounds.x + anchor.right - width),
      y: Math.round(contentBounds.y + anchor.bottom + 5)
    };
    const workArea = screen.getDisplayNearestPoint(requested).workArea;
    const x = Math.max(workArea.x + 8, Math.min(requested.x, workArea.x + workArea.width - width - 8));
    const y = Math.max(workArea.y + 8, Math.min(requested.y, workArea.y + workArea.height - height - 8));

    const popup = new BrowserWindow({
      parent: this.parent,
      width,
      height,
      x,
      y,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      roundedCorners: true,
      webPreferences: {
        preload: path.resolve(__dirname, '../preload/presence-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    this.window = popup;
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    popup.on('blur', () => {
      this.blurTimer = setTimeout(() => this.close(), 100);
    });
    popup.on('closed', () => {
      if (this.window === popup) this.window = null;
      if (this.parent && !this.parent.isDestroyed()) this.parent.webContents.send('latex:presence-popover-closed');
    });
    await popup.loadFile(path.resolve(__dirname, '../renderer/presence.html'));
    if (popup.isDestroyed()) return false;
    popup.webContents.send('presence:data', { participants, currentUserId: data.currentUserId || null });
    popup.show();
    return true;
  }

  dispose() { this.close(); }
}

module.exports = { PresenceWindowManager };
