const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

class CodeServerManager {
  constructor(config, log = console, dependencies = {}) {
    this.config = config;
    this.log = log;
    this.fetch = dependencies.fetch || global.fetch;
    this.spawn = dependencies.spawn || spawn;
    this.child = null;
    this.port = null;
    this.spawnError = null;
    this.stopping = false;
    this.recentOutput = [];
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async findAvailablePort(startPort = this.config.preferredPort) {
    for (let port = startPort; port < startPort + 100; port += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await this.#portIsFree(port)) return port;
    }
    throw new Error(`Không tìm thấy cổng trống trong khoảng ${startPort}-${startPort + 99}.`);
  }

  async start() {
    if (this.isRunning()) return this.port;
    const executable = this.#resolveExecutable();
    this.port = await this.findAvailablePort();
    this.stopping = false;
    this.spawnError = null;
    this.recentOutput = [];
    fs.mkdirSync(this.config.appDataDir, { recursive: true });
    fs.mkdirSync(this.config.extensionsDir, { recursive: true });
    this.#writeGlobalSettings();

    const args = [
      '--bind-addr', `${this.config.host}:${this.port}`,
      '--auth', this.config.auth,
      '--disable-workspace-trust',
      '--disable-telemetry',
      '--user-data-dir', this.config.appDataDir,
      '--extensions-dir', this.config.extensionsDir
    ];
    const isCmd = process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd');
    const command = isCmd ? (process.env.ComSpec || 'cmd.exe') : executable;
    const commandArgs = isCmd ? ['/d', '/c', 'call', executable, ...args] : args;
    this.log.info(`Starting code-server on ${this.config.host}:${this.port}`);
    const child = this.spawn(command, commandArgs, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: [this.config.additionalPath, process.env.PATH].filter(Boolean).join(path.delimiter)
      }
    });
    this.child = child;
    child.stdout?.on('data', (data) => this.#capture('info', data));
    child.stderr?.on('data', (data) => this.#capture('error', data));
    child.once('error', (error) => {
      this.spawnError = error;
      this.log.error('code-server spawn error:', error);
    });
    child.once('exit', (code, signal) => {
      this.log.info(`code-server exited (code=${code}, signal=${signal})`);
      if (this.child === child) this.child = null;
    });
    return this.port;
  }

  async checkHealth(port = this.port) {
    if (!port) return false;
    for (const route of ['/healthz', '/']) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await this.fetch(`http://${this.config.host}:${port}${route}`, { signal: controller.signal });
        if (response.ok) return true;
      } catch {
        // Startup polling intentionally ignores transient connection failures.
      } finally {
        clearTimeout(timer);
      }
    }
    return false;
  }

  async waitUntilReady(timeoutMs = this.config.readyTimeoutMs) {
    const child = this.child;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.spawnError) throw new Error(this.#failure(`Không thể chạy code-server: ${this.spawnError.message}`));
      if (!child || child !== this.child || child.exitCode !== null || child.killed) {
        throw new Error(this.#failure('code-server đã dừng trước khi sẵn sàng'));
      }
      // eslint-disable-next-line no-await-in-loop
      if (await this.checkHealth()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(this.#failure(`code-server chưa sẵn sàng sau ${timeoutMs}ms`));
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      let finished = false;
      const done = () => { if (!finished) { finished = true; resolve(); } };
      child.once('exit', done);
      if (process.platform === 'win32') {
        const killer = this.spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false, windowsHide: true, stdio: 'ignore'
        });
        killer.once('error', done);
        killer.once('exit', done);
      } else {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5_000).unref();
      }
      setTimeout(done, 6_000).unref();
    });
  }

  #resolveExecutable() {
    if (this.config.executable && fs.existsSync(this.config.executable)) return this.config.executable;
    const candidates = process.platform === 'win32'
      ? [path.join(process.env.APPDATA || '', 'npm', 'code-server.cmd')]
      : ['/usr/local/bin/code-server', '/usr/bin/code-server'];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
    throw new Error('Không tìm thấy code-server. Hãy chạy npm run setup:code-server.');
  }

  #capture(level, data) {
    const message = data.toString().trimEnd();
    if (!message) return;
    this.recentOutput.push(...message.split(/\r?\n/).filter(Boolean));
    if (this.recentOutput.length > 20) this.recentOutput.splice(0, this.recentOutput.length - 20);
    this.log[level](`[code-server] ${message}`);
  }

  #failure(message) {
    const details = this.recentOutput.slice(-4).join(' | ');
    return details ? `${message}. Log cuối: ${details}` : message;
  }

  #portIsFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen({ host: this.config.host, port, exclusive: true });
    });
  }

  #writeGlobalSettings() {
    try {
      const userDir = path.join(this.config.appDataDir, 'User');
      const machineDir = path.join(this.config.appDataDir, 'Machine');
      fs.mkdirSync(userDir, { recursive: true });
      fs.mkdirSync(machineDir, { recursive: true });

      const settings = {
        'window.commandCenter': false,
        'window.customTitleBarVisibility': 'never',
        'workbench.startupEditor': 'welcomePage'
      };

      const settingsJson = `${JSON.stringify(settings, null, 2)}\n`;

      const userSettingsPath = path.join(userDir, 'settings.json');
      if (!fs.existsSync(userSettingsPath)) {
        fs.writeFileSync(userSettingsPath, settingsJson, 'utf8');
      } else {
        const current = JSON.parse(fs.readFileSync(userSettingsPath, 'utf8'));
        if (current['window.commandCenter'] !== false) {
           fs.writeFileSync(userSettingsPath, JSON.stringify({ ...current, ...settings }, null, 2), 'utf8');
        }
      }

      const machineSettingsPath = path.join(machineDir, 'settings.json');
      if (!fs.existsSync(machineSettingsPath)) {
        fs.writeFileSync(machineSettingsPath, settingsJson, 'utf8');
      } else {
        const current = JSON.parse(fs.readFileSync(machineSettingsPath, 'utf8'));
        if (current['window.commandCenter'] !== false) {
           fs.writeFileSync(machineSettingsPath, JSON.stringify({ ...current, ...settings }, null, 2), 'utf8');
        }
      }
    } catch (error) {
      this.log.error('Failed to write global code-server settings:', error);
    }
  }
}

module.exports = { CodeServerManager };
