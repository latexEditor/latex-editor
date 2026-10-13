const { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, session, safeStorage } = require('electron');
const path = require('node:path');
const config = require('./config');
const { CodeServerManager } = require('./CodeServerManager');
const { WorkspaceManager } = require('./WorkspaceManager');
const { LatexRuntimeManager } = require('./LatexRuntimeManager');
const { registerIpc } = require('./ipc');
const { HistoryManager } = require('./HistoryManager');
const { AuthManager } = require('./AuthManager');
const { CloudSyncManager } = require('./CloudSyncManager');
const { CollaborationManager } = require('./CollaborationManager');
const { CollaborationBridge } = require('./CollaborationBridge');
const { PresenceWindowManager } = require('./PresenceWindowManager');
const { registerFeatureIpc } = require('./featureIpc');

const TOPBAR_HEIGHT = 32;
let mainWindow;
let editorView;
let serverManager;
let workspaceManager;
let runtimeManager;
let authManager;
let collaborationManager;
let collaborationBridge;
let presenceWindowManager;
let activeProject;
let serverUrl;
let quitting = false;
let shellOverlayOpen = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function state() {
  return {
    phase: serverUrl ? 'ready' : 'starting',
    project: activeProject || null,
    openProjects: workspaceManager?.listOpenProjects() || [],
    projectsDir: workspaceManager?.projectsDir || '',
    auth: authManager?.status() || { configured: false, signedIn: false },
    collaboration: collaborationManager?.status() || { enabled: false, connection: 'offline', participants: [], error: null },
    serverUrl: serverUrl?.toString() || null
  };
}

function getEditorPresenceData() {
  const current = state();
  const collab = current.collaboration || { enabled: false, connection: 'offline', participants: [] };
  const visible = Boolean(activeProject);
  const currentUser = current.auth?.user;
  const selfAvatar = currentUser?.avatar_url || currentUser?.avatarUrl || currentUser?.picture || null;
  const selfName = currentUser?.name || currentUser?.email || 'Bạn';
  const selfParticipant = {
    id: currentUser?.id || 'self',
    name: selfName,
    role: 'owner',
    email: currentUser?.email || '',
    avatarUrl: selfAvatar,
    isSelf: true
  };
  const rawParticipants = (collab.enabled && Array.isArray(collab.participants) && collab.participants.length)
    ? collab.participants
    : [];
  const participants = rawParticipants.length
    ? rawParticipants.map((p) => {
        const isSelf = p.id === currentUser?.id || p.isSelf;
        return {
          ...p,
          name: isSelf ? selfName : (p.name || 'Thành viên'),
          avatarUrl: p.avatarUrl || p.avatar_url || (isSelf ? selfAvatar : null),
          isSelf
        };
      })
    : [selfParticipant];
  const count = participants.length;
  const status = collab.connection || 'online';
  return {
    visible,
    count,
    status,
    participants,
    error: collab.error || null,
    currentUser: selfParticipant
  };
}

function updateEditorPresence() {
  try {
    if (!editorView?.webContents || editorView.webContents.isDestroyed()) return;
    const data = getEditorPresenceData();
    editorView.webContents.executeJavaScript(`
      if (typeof window.__latexUpdatePresence === 'function') {
        window.__latexUpdatePresence(${JSON.stringify(data)});
      } else {
        window.__latexLatestPresence = ${JSON.stringify(data)};
      }
    `).catch(() => {});
  } catch (error) {
    console.warn('Failed to update editor presence:', error);
  }
}

function notifyState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('latex:state-changed', state());
  updateEditorPresence();
}

function layoutEditor() {
  if (!mainWindow || !editorView) return;
  if (!activeProject || shellOverlayOpen) {
    hideEditor();
    return;
  }
  try {
    if (!mainWindow.contentView?.children?.includes(editorView)) {
      mainWindow.contentView.addChildView(editorView);
    }
    editorView.setVisible(true);
  } catch {}
  const [width, height] = mainWindow.getContentSize();
  editorView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width, height: Math.max(0, height - TOPBAR_HEIGHT) });
}

function hideEditor() {
  if (!mainWindow || !editorView) return;
  try { editorView.setVisible(false); } catch {}
  try {
    if (mainWindow.contentView?.children?.includes(editorView)) {
      mainWindow.contentView.removeChildView(editorView);
    }
  } catch {}
  editorView.setBounds({ x: -10000, y: -10000, width: 0, height: 0 });
  if (mainWindow?.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
  }
}

function showEditor() {
  if (activeProject) layoutEditor();
  else hideEditor();
}

function allowedEditorUrl(target) {
  try {
    const url = new URL(target);
    return Boolean(serverUrl && url.origin === serverUrl.origin);
  } catch {
    return false;
  }
}

const EDITOR_CUSTOM_CSS = `
  .activitybar .action-item:has(.codicon-account),
  .activitybar .action-item:has([class*="codicon-account"]),
  .activitybar .action-item:has([aria-label*="Account" i]),
  .activitybar .action-item:has([aria-label*="Accounts" i]),
  .activitybar .action-item:has([aria-label*="Tài khoản" i]),
  .activitybar .action-item:has([aria-label*="Profile" i]),
  .activitybar li.action-item[aria-label*="Account" i],
  .activitybar li.action-item[aria-label*="Accounts" i],
  .activitybar li.action-item[aria-label*="Tài khoản" i],
  .activitybar li.action-item[aria-label*="Profile" i],
  .action-item:has(.codicon-account),
  .action-item:has([class*="codicon-account"]),
  .action-item:has([aria-label*="Account" i]),
  .action-item:has([aria-label*="Accounts" i]),
  .action-item:has([aria-label*="Tài khoản" i]),
  li.action-item[aria-label*="Account" i],
  li.action-item[aria-label*="Accounts" i],
  li.action-item[aria-label*="Tài khoản" i],
  [aria-label*="Accounts" i].action-item,
  [aria-label*="Tài khoản" i].action-item,
  .codicon-account,
  [class*="codicon-account"] {
    display: none !important;
  }

  .part.titlebar .window-title {
    font-size: 11.5px !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    opacity: 0.85 !important;
  }

  .part.titlebar {
    position: relative !important;
  }

  #latex-editor-presence-pill {
    position: absolute !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    right: 142px !important;
    z-index: 100 !important;
    display: inline-flex !important;
    align-items: center !important;
    cursor: pointer !important;
    user-select: none !important;
    padding: 1px !important;
    border-radius: 9999px !important;
    transition: transform 0.15s ease, filter 0.15s ease !important;
    -webkit-app-region: no-drag !important;
    pointer-events: auto !important;
  }
  #latex-editor-presence-pill * {
    -webkit-app-region: no-drag !important;
    pointer-events: auto !important;
  }
  #latex-editor-presence-pill:hover {
    filter: brightness(0.96) !important;
  }
  #latex-editor-presence-pill .stack-avatar {
    position: relative !important;
    width: 20px !important;
    height: 20px !important;
    border-radius: 50% !important;
    border: 1.5px solid #ffffff !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12) !important;
    background: #e0e7ff !important;
    color: #4338ca !important;
    font-size: 8.5px !important;
    font-weight: 700 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    display: grid !important;
    place-items: center !important;
    overflow: hidden !important;
    flex-shrink: 0 !important;
    transition: transform 0.15s ease, z-index 0.15s ease !important;
  }
  #latex-editor-presence-pill .stack-avatar:not(:first-child) {
    margin-left: -5px !important;
  }
  #latex-editor-presence-pill .stack-avatar:hover {
    transform: scale(1.15) !important;
    z-index: 10 !important;
  }
  #latex-editor-presence-pill .stack-avatar img {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    border-radius: 50% !important;
    object-fit: cover !important;
    display: block !important;
  }
  #latex-editor-presence-pill .stack-overflow {
    position: relative !important;
    width: 20px !important;
    height: 20px !important;
    border-radius: 50% !important;
    border: 1.5px solid #ffffff !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12) !important;
    background: #f1f5f9 !important;
    color: #475569 !important;
    font-size: 8px !important;
    font-weight: 700 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    display: grid !important;
    place-items: center !important;
    margin-left: -5px !important;
    flex-shrink: 0 !important;
  }
  #latex-editor-presence-pill .stack-dot {
    position: absolute !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 6px !important;
    height: 6px !important;
    border-radius: 50% !important;
    background: #10b981 !important;
    border: 1px solid #ffffff !important;
    pointer-events: none !important;
    z-index: 20 !important;
  }
  #latex-editor-presence-pill.connecting .stack-dot {
    background: #f59e0b !important;
    animation: latex-presence-pulse 1.5s infinite !important;
  }
  #latex-editor-presence-pill.error .stack-dot {
    background: #ef4444 !important;
  }
  #latex-editor-presence-popover {
    position: fixed !important;
    z-index: 100000 !important;
    -webkit-app-region: no-drag !important;
    pointer-events: auto !important;
    width: 286px !important;
    max-height: 320px !important;
    overflow: auto !important;
    padding: 10px 12px !important;
    border: 1px solid rgba(100, 116, 139, 0.24) !important;
    border-radius: 12px !important;
    background: #ffffff !important;
    color: #172033 !important;
    box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18) !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
  }
  #latex-editor-presence-popover * {
    -webkit-app-region: no-drag !important;
    pointer-events: auto !important;
  }
  #latex-editor-presence-popover .presence-heading {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 2px 2px 9px !important;
    border-bottom: 1px solid #e5e7eb !important;
    font-size: 13px !important;
    font-weight: 650 !important;
  }
  #latex-editor-presence-popover .presence-total {
    color: #64748b !important;
    font-size: 11.5px !important;
    font-weight: 500 !important;
  }
  #latex-editor-presence-popover .presence-person {
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
    padding: 10px 2px 4px !important;
  }
  #latex-editor-presence-popover .presence-avatar-wrap {
    position: relative !important;
    width: 36px !important;
    height: 36px !important;
    flex: 0 0 36px !important;
  }
  #latex-editor-presence-popover .presence-avatar {
    position: relative !important;
    display: grid !important;
    place-items: center !important;
    width: 36px !important;
    height: 36px !important;
    overflow: hidden !important;
    border-radius: 50% !important;
    background: #e0e7ff !important;
    color: #4338ca !important;
    font-size: 13px !important;
    font-weight: 700 !important;
  }
  #latex-editor-presence-popover .presence-avatar img {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    border-radius: 50% !important;
    object-fit: cover !important;
    display: block !important;
  }
  #latex-editor-presence-popover .presence-online-dot {
    position: absolute !important;
    right: -1px !important;
    bottom: -1px !important;
    width: 9px !important;
    height: 9px !important;
    border: 2px solid #fff !important;
    border-radius: 50% !important;
    background: #10b981 !important;
    pointer-events: none !important;
  }
  #latex-editor-presence-popover .presence-details {
    min-width: 0 !important;
  }
  #latex-editor-presence-popover .presence-name {
    overflow: hidden !important;
    color: #172033 !important;
    font-size: 12.5px !important;
    font-weight: 650 !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  #latex-editor-presence-popover .presence-role {
    margin-top: 2px !important;
    color: #64748b !important;
    font-size: 11.5px !important;
  }
  #latex-editor-presence-popover .presence-person.jumpable {
    cursor: pointer !important;
    border-radius: 8px !important;
    padding: 6px 8px !important;
    margin: 2px -6px !important;
    transition: background 0.15s ease !important;
  }
  #latex-editor-presence-popover .presence-person.jumpable:hover {
    background: #f1f5f9 !important;
  }
  #latex-editor-presence-popover .presence-jump-hint {
    margin-left: auto !important;
    font-size: 11px !important;
    color: #4338ca !important;
    background: #e0e7ff !important;
    padding: 3px 8px !important;
    border-radius: 9999px !important;
    font-weight: 600 !important;
    white-space: nowrap !important;
    flex-shrink: 0 !important;
  }
  @keyframes latex-presence-pulse { 50% { opacity: 0.4; } }
`;

const EDITOR_CUSTOM_SCRIPT = `
  (() => {
    let latestData = window.__latexLatestPresence || { visible: true, count: 1, status: 'online', participants: [] };
    let updateScheduled = false;

    function closePopover() {
      document.querySelector('#latex-editor-presence-popover')?.remove();
      document.querySelector('#latex-editor-presence-pill')?.setAttribute('aria-expanded', 'false');
    }

    function initials(name) {
      const trimmed = String(name || 'U').trim();
      const parts = trimmed.split(/\\s+/).filter(Boolean);
      if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      }
      return trimmed.slice(0, 2).toUpperCase() || 'U';
    }

    function renderPersonRow(person) {
      const row = document.createElement('div');
      row.className = 'presence-person';

      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'presence-avatar-wrap';

      const avatar = document.createElement('div');
      avatar.className = 'presence-avatar';

      const initialsSpan = document.createElement('span');
      initialsSpan.className = 'presence-initials';
      initialsSpan.textContent = initials(person.name);
      avatar.appendChild(initialsSpan);

      const imageUrl = person.avatarUrl || person.avatar_url || person.avatar || person.picture;
      if (imageUrl) {
        const image = document.createElement('img');
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.src = imageUrl;
        image.addEventListener('load', () => {
          initialsSpan.style.display = 'none';
          avatar.style.background = 'transparent';
        }, { once: true });
        image.addEventListener('error', () => {
          image.remove();
          initialsSpan.style.display = '';
        }, { once: true });
        avatar.appendChild(image);
      }

      const dot = document.createElement('span');
      dot.className = 'presence-online-dot';
      avatarWrap.append(avatar, dot);

      const details = document.createElement('div');
      details.className = 'presence-details';
      const name = document.createElement('div');
      name.className = 'presence-name';
      const displayName = String(person.name || person.email || 'Người dùng');
      name.textContent = person.isSelf
        ? (displayName === 'Bạn' ? 'Bạn' : (displayName + ' (Bạn)'))
        : displayName;
      const role = document.createElement('div');
      role.className = 'presence-role';
      role.textContent = person.role === 'owner' ? 'Chủ sở hữu' : (person.role === 'editor' ? 'Có thể chỉnh sửa' : 'Người xem');
      details.append(name, role);

      row.append(avatarWrap, details);

      if (!person.isSelf && person.id) {
        row.classList.add('jumpable');
        row.title = 'Nhấp để nhảy tới vị trí con trỏ của ' + displayName;
        const jumpBtn = document.createElement('span');
        jumpBtn.className = 'presence-jump-hint';
        jumpBtn.textContent = '👁 Theo dõi';
        row.appendChild(jumpBtn);
        row.addEventListener('click', async () => {
          closePopover();
          if (window.latexDesktopBridge?.jumpToUser) {
            await window.latexDesktopBridge.jumpToUser(person.id);
          }
        });
      }

      return row;
    }

    function openPopover(pill) {
      closePopover();
      const popover = document.createElement('div');
      popover.id = 'latex-editor-presence-popover';
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', 'Danh sách người đang online');

      const data = window.__latexLatestPresence || latestData || {};
      const heading = document.createElement('div');
      heading.className = 'presence-heading';
      const headingText = document.createElement('span');
      headingText.textContent = 'Đang online';
      const total = document.createElement('span');
      total.className = 'presence-total';
      total.textContent = String(data.count || 1) + ' người';
      heading.append(headingText, total);
      popover.appendChild(heading);

      const fallbackUser = data.currentUser || { name: 'Bạn', role: 'owner', isSelf: true, avatarUrl: null };
      const people = Array.isArray(data.participants) && data.participants.length
        ? data.participants
        : [fallbackUser];

      people.forEach((person) => {
        popover.appendChild(renderPersonRow(person));
      });

      document.body.appendChild(popover);
      const rect = pill.getBoundingClientRect();
      const width = popover.offsetWidth || 286;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      popover.style.left = left + 'px';
      popover.style.top = Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 8) + 'px';
      pill.setAttribute('aria-expanded', 'true');
    }

    function cleanTitle() {
      const titleEl = document.querySelector('.part.titlebar .window-title');
      if (titleEl && titleEl.textContent && titleEl.textContent.includes(' - code-server')) {
        titleEl.textContent = titleEl.textContent.replace(' - code-server', '');
      }
    }

    const AVATAR_PALETTE = [
      { bg: '#e0e7ff', text: '#4338ca' },
      { bg: '#d1fae5', text: '#065f46' },
      { bg: '#fef3c7', text: '#92400e' },
      { bg: '#fce7f3', text: '#9d174d' },
      { bg: '#e0f2fe', text: '#0369a1' },
      { bg: '#f3e8ff', text: '#6b21a8' }
    ];

    function getAvatarColor(str) {
      let hash = 0;
      const s = String(str || '');
      for (let i = 0; i < s.length; i++) hash = (hash << 5) - hash + s.charCodeAt(i);
      return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
    }

    function renderAvatarStack(pill) {
      pill.replaceChildren();

      const data = window.__latexLatestPresence || latestData || {};
      const fallbackUser = data.currentUser || { name: 'Bạn', role: 'owner', isSelf: true, avatarUrl: null };
      const people = Array.isArray(data.participants) && data.participants.length
        ? data.participants
        : [fallbackUser];

      const MAX_VISIBLE = 3;
      const visiblePeople = people.slice(0, MAX_VISIBLE);
      const overflowCount = people.length - MAX_VISIBLE;

      visiblePeople.forEach((person) => {
        const item = document.createElement('div');
        item.className = 'stack-avatar';
        const color = getAvatarColor(person.id || person.name);
        item.style.background = color.bg;
        item.style.color = color.text;

        const initialsSpan = document.createElement('span');
        initialsSpan.textContent = initials(person.name);
        item.appendChild(initialsSpan);

        const imageUrl = person.avatarUrl || person.avatar_url || person.avatar || person.picture;
        if (imageUrl) {
          const img = document.createElement('img');
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          img.src = imageUrl;
          img.addEventListener('load', () => {
            initialsSpan.style.display = 'none';
            item.style.background = 'transparent';
          }, { once: true });
          img.addEventListener('error', () => {
            img.remove();
            initialsSpan.style.display = '';
          }, { once: true });
          item.appendChild(img);
        }

        const roleText = person.role === 'owner' ? 'Chủ sở hữu' : (person.role === 'editor' ? 'Chỉnh sửa' : 'Xem');
        const nameText = person.isSelf ? (person.name === 'Bạn' ? 'Bạn' : (person.name + ' (Bạn)')) : (person.name || 'Thành viên');
        if (!person.isSelf && person.id) {
          item.style.cursor = 'pointer';
          item.title = nameText + ' · ' + roleText + ' (Nhấp để theo dõi con trỏ)';
          item.addEventListener('click', async (event) => {
            event.stopPropagation();
            closePopover();
            if (window.latexDesktopBridge?.jumpToUser) {
              await window.latexDesktopBridge.jumpToUser(person.id);
            }
          });
        } else {
          item.title = nameText + ' · ' + roleText;
        }
        pill.appendChild(item);
      });

      if (overflowCount > 0) {
        const overflowEl = document.createElement('div');
        overflowEl.className = 'stack-overflow';
        overflowEl.textContent = '+' + overflowCount;
        overflowEl.title = 'và ' + overflowCount + ' người khác đang online';
        pill.appendChild(overflowEl);
      }

      const dot = document.createElement('span');
      dot.className = 'stack-dot';
      pill.appendChild(dot);

      pill.title = people.map((p) => {
        const role = p.role === 'owner' ? 'Chủ sở hữu' : (p.role === 'editor' ? 'Chỉnh sửa' : 'Xem');
        const name = p.isSelf ? (p.name === 'Bạn' ? 'Bạn' : (p.name + ' (Bạn)')) : (p.name || 'Thành viên');
        return name + ' (' + role + ')';
      }).join('\\n') + '\\n(Nhấp để xem danh sách)';
    }

    function ensurePill() {
      cleanTitle();
      let pill = document.querySelector('#latex-editor-presence-pill');
      if (!latestData.visible) {
        if (pill) pill.remove();
        closePopover();
        return;
      }

      const titlebar = document.querySelector('.part.titlebar');
      if (!titlebar) return;

      if (!pill) {
        pill = document.createElement('div');
        pill.id = 'latex-editor-presence-pill';
        pill.setAttribute('role', 'button');
        pill.setAttribute('tabindex', '0');
        pill.setAttribute('aria-haspopup', 'dialog');
        pill.setAttribute('aria-expanded', 'false');
        pill.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (document.querySelector('#latex-editor-presence-popover')) {
            closePopover();
            return;
          }
          if (window.latexDesktopBridge?.getPresence) {
            try {
              const freshData = await window.latexDesktopBridge.getPresence();
              if (freshData) {
                latestData = freshData;
                window.__latexLatestPresence = freshData;
              }
            } catch {}
          }
          openPopover(pill);
        });
        pill.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            pill.click();
          }
        });
      }

      if (!titlebar.contains(pill)) {
        titlebar.appendChild(pill);
      }

      pill.className = latestData.status === 'connecting'
        ? 'connecting'
        : (latestData.status === 'error' || latestData.status === 'revoked' ? 'error' : '');

      renderAvatarStack(pill);
    }

    function scheduleEnsurePill() {
      if (updateScheduled) return;
      updateScheduled = true;
      requestAnimationFrame(() => {
        updateScheduled = false;
        ensurePill();
      });
    }

    window.__latexUpdatePresence = (data) => {
      latestData = data || { visible: false, count: 0, status: 'offline', participants: [] };
      window.__latexLatestPresence = latestData;
      scheduleEnsurePill();
    };

    if (!window.__latexEditorObserver) {
      // VS Code creates thousands of DOM nodes during startup. Querying the
      // complete document for every mutation can starve its Extension Host
      // WebSocket and leave the workbench permanently white. CSS already
      // hides the account action; this observer only coalesces the small
      // presence/title update to at most one pass per animation frame.
      window.__latexEditorObserver = new MutationObserver(scheduleEnsurePill);
      window.__latexEditorObserver.observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener('pointerdown', (event) => {
        if (!event.target.closest?.('#latex-editor-presence-pill, #latex-editor-presence-popover')) closePopover();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closePopover();
      });
    }

    scheduleEnsurePill();
  })();
`;

async function applyEditorCustomizations() {
  if (!editorView?.webContents || editorView.webContents.isDestroyed()) return;
  try {
    await editorView.webContents.insertCSS(EDITOR_CUSTOM_CSS);
  } catch {
    // Ignore transient navigation errors
  }
  try {
    const data = getEditorPresenceData();
    await editorView.webContents.executeJavaScript(
      'window.__latexLatestPresence = ' + JSON.stringify(data) + ';\n' +
      EDITOR_CUSTOM_SCRIPT
    );
    updateEditorPresence();
  } catch {
    // Ignore transient script errors
  }
}

function isSameEditorUrl(currentUrl, targetUrl) {
  if (!currentUrl || currentUrl === 'about:blank') return false;
  try {
    const cur = new URL(currentUrl);
    const tar = new URL(targetUrl);
    if (cur.origin !== tar.origin) return false;
    const curFolder = decodeURIComponent(cur.searchParams.get('folder') || '').replace(/\\/g, '/').toLowerCase();
    const tarFolder = decodeURIComponent(tar.searchParams.get('folder') || '').replace(/\\/g, '/').toLowerCase();
    return Boolean(curFolder && tarFolder && curFolder === tarFolder);
  } catch {
    return false;
  }
}

async function loadProject(projectPath) {
  if (!projectPath) {
    collaborationManager?.close();
    activeProject = null;
    shellOverlayOpen = false;
    hideEditor();
    notifyState();
    return null;
  }
  // Opening a project is also a recovery boundary: native/open-folder dialogs
  // and renderer modals must never be able to leave the editor detached after
  // the project has loaded.
  shellOverlayOpen = false;
  activeProject = workspaceManager.openProject(projectPath);
  const target = workspaceManager.codeServerUrl(config.host, serverManager.port, activeProject.path);
  showEditor();
  notifyState();
  const currentUrl = editorView?.webContents?.getURL();
  if (!isSameEditorUrl(currentUrl, target.toString())) {
    try {
      await editorView.webContents.loadURL(target.toString());
    } catch (err) {
      if (!err.message?.includes('ERR_ABORTED')) {
        console.warn('loadURL warning:', err.message);
      }
    }
    await applyEditorCustomizations();
  }
  showEditor();
  if (editorView?.webContents) {
    editorView.webContents.focus();
    editorView.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"));').catch(() => {});
  }
  collaborationManager?.open(activeProject.path).catch(() => {});
  notifyState();
  return activeProject;
}

async function closeProjectTab(projectPath) {
  const closingActiveProject = activeProject?.path
    && path.resolve(activeProject.path).toLowerCase() === path.resolve(projectPath).toLowerCase();
  const nextProject = workspaceManager.closeProject(projectPath);
  if (closingActiveProject) await loadProject(nextProject?.path || null);
  else notifyState();
  return nextProject;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    title: 'LaTeX Editor',
    icon: config.iconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f8fafc',
      symbolColor: '#334155',
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('resize', layoutEditor);
  mainWindow.on('closed', () => { mainWindow = null; });

  ipcMain.on('latex:editor-toggle-presence', (_event, rect) => {
    if (!rect) return;
    const anchor = {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom + TOPBAR_HEIGHT
    };
    presenceWindowManager?.toggle(anchor);
  });

  ipcMain.removeHandler('latex:get-presence');
  ipcMain.handle('latex:get-presence', () => getEditorPresenceData());

  editorView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../preload/editor-preload.js')
    }
  });
  mainWindow.contentView.addChildView(editorView);
  layoutEditor();
  editorView.webContents.on('dom-ready', applyEditorCustomizations);
  editorView.webContents.on('did-finish-load', applyEditorCustomizations);
  editorView.webContents.on('will-navigate', (event, target) => {
    if (!allowedEditorUrl(target)) event.preventDefault();
  });
  editorView.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedEditorUrl(url)) return { action: 'allow' };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.show();
}

async function startup() {
  const startupStartedAt = Date.now();
  runtimeManager = new LatexRuntimeManager({ cacheFile: config.runtimeStatusFile });
  const runtimeStatus = runtimeManager.getStatus();
  config.additionalPath = runtimeStatus.pathEntries.join(path.delimiter);
  workspaceManager = new WorkspaceManager(config, { runtimeStatus });
  serverManager = new CodeServerManager(config);
  workspaceManager.initialize();
  collaborationBridge = new CollaborationBridge({
    onMessage: (message) => collaborationManager?.handleEditorMessage(message)
  });
  const bridge = await collaborationBridge.start();
  config.collaborationBridgePort = bridge.port;
  config.collaborationBridgeToken = bridge.token;
  let serverStartupError = null;
  const serverReady = (async () => {
    await serverManager.start();
    await serverManager.waitUntilReady();
    serverUrl = new URL(`http://${config.host}:${serverManager.port}`);
    notifyState();
  })().catch((error) => { serverStartupError = error; });
  const history = new HistoryManager(config);
  authManager = new AuthManager(config, {
    safeStorage,
    openExternal: (url) => shell.openExternal(url),
    onChange: () => {
      collaborationManager?.open(activeProject?.path || null).catch(() => {});
      notifyState();
    }
  });
  await authManager.initialize();
  const cloud = new CloudSyncManager(config, { auth: authManager, history, workspace: workspaceManager });
  collaborationManager = new CollaborationManager({
    auth: authManager,
    cloud,
    onChange: notifyState,
    onEditorMessage: (message) => collaborationBridge?.publish(message)
  });
  registerFeatureIpc({
    ipcMain, dialog, workspace: workspaceManager, history, auth: authManager, cloud,
    collaboration: collaborationManager, openProject: loadProject
  });
  const restoredProjects = workspaceManager.listOpenProjects();
  const mostRecentOpenProject = workspaceManager.listRecent().find((recentProject) => (
    restoredProjects.some((openProject) => openProject.path.toLowerCase() === recentProject.path.toLowerCase())
  ));
  activeProject = mostRecentOpenProject || restoredProjects[0]
    || (workspaceManager.hasOpenProjectsState() ? null : workspaceManager.ensureWelcomeProject());
  registerIpc({
    ipcMain,
    dialog,
    workspaceManager,
    runtimeManager,
    auth: authManager,
    cloud,
    openProject: loadProject,
    closeProject: closeProjectTab,
    hideEditor: () => { shellOverlayOpen = true; hideEditor(); },
    showEditor: () => {
      shellOverlayOpen = false;
      showEditor();
      if (activeProject && editorView?.webContents) {
        editorView.webContents.focus();
        editorView.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"));').catch(() => {});
      }
    },
    togglePresencePopover: (anchor) => presenceWindowManager?.toggle(anchor) || false,
    jumpToUser: (userId) => {
      presenceWindowManager?.close();
      return collaborationManager?.jumpToParticipant(userId);
    },
    getState: state
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await createWindow();
  presenceWindowManager = new PresenceWindowManager(mainWindow, () => {
    const rawParticipants = collaborationManager?.status().participants || [];
    const currentUser = authManager?.status().user;
    const selfAvatar = currentUser?.avatar_url || currentUser?.avatarUrl || currentUser?.picture || null;
    const participants = rawParticipants.map((p) => {
      const isSelf = p.id === currentUser?.id || p.isSelf;
      return {
        ...p,
        avatarUrl: p.avatarUrl || p.avatar_url || (isSelf ? selfAvatar : null),
        isSelf
      };
    });
    if (!participants.length && currentUser) {
      return {
        participants: [{
          id: currentUser.id || 'self',
          name: currentUser.name,
          role: 'owner',
          email: currentUser.email,
          avatarUrl: selfAvatar,
          isSelf: true
        }],
        currentUserId: currentUser.id || 'self'
      };
    }
    return {
      participants,
      currentUserId: currentUser?.id || null
    };
  });
  await serverReady;
  if (serverStartupError) throw serverStartupError;
  await loadProject(activeProject?.path || null);
  console.info(`LaTeX Editor ready in ${Date.now() - startupStartedAt}ms`);
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  ipcMain.removeHandler('latex:get-presence');
  authManager?.dispose();
  collaborationManager?.dispose();
  presenceWindowManager?.dispose();
  await Promise.allSettled([serverManager?.stop(), collaborationBridge?.stop()]);
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startup).catch(async (error) => {
  console.error('Startup failed:', error);
  await shutdown();
  await dialog.showMessageBox({
    type: 'error',
    title: 'Không thể khởi động LaTeX Editor',
    message: error.message,
    detail: 'Kiểm tra README và chạy npm run setup trước khi thử lại.'
  });
  app.quit();
  });

  const quitFromSignal = () => shutdown().finally(() => app.quit());
  process.once('SIGINT', quitFromSignal);
  process.once('SIGTERM', quitFromSignal);
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
app.on('render-process-gone', (_event, webContents) => {
  if (webContents === mainWindow?.webContents || webContents === editorView?.webContents) shutdown();
});
app.on('child-process-gone', () => shutdown());
