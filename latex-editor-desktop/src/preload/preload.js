const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latexEditor', {
  getState: () => ipcRenderer.invoke('latex:get-state'),
  listProjects: () => ipcRenderer.invoke('latex:list-projects'),
  listTemplates: () => ipcRenderer.invoke('latex:list-templates'),
  forgetProject: (projectPath) => ipcRenderer.invoke('latex:forget-project', projectPath),
  revealProject: (projectPath) => ipcRenderer.invoke('latex:reveal-project', projectPath),
  createProject: (name, templateId) => ipcRenderer.invoke('latex:create-project', name, templateId),
  chooseProject: () => ipcRenderer.invoke('latex:choose-project'),
  openProject: (projectPath) => ipcRenderer.invoke('latex:open-project', projectPath),
  closeProject: (projectPath) => ipcRenderer.invoke('latex:close-project', projectPath),
  hideEditor: () => ipcRenderer.invoke('latex:hide-editor'),
  showEditor: () => ipcRenderer.invoke('latex:show-editor'),
  getRuntimeStatus: () => ipcRenderer.invoke('latex:get-runtime-status'),
  historyList: (project) => ipcRenderer.invoke('latex:history-list', project),
  historySave: (project, message) => ipcRenderer.invoke('latex:history-save', project, message),
  historyDiff: (project, hash) => ipcRenderer.invoke('latex:history-diff', project, hash),
  historyRestore: (project, hash) => ipcRenderer.invoke('latex:history-restore', project, hash),
  authStatus: () => ipcRenderer.invoke('latex:auth-status'),
  login: () => ipcRenderer.invoke('latex:auth-login'),
  logout: () => ipcRenderer.invoke('latex:auth-logout'),
  cloudList: () => ipcRenderer.invoke('latex:cloud-list'),
  cloudUpload: (project) => ipcRenderer.invoke('latex:cloud-upload', project),
  cloudDownload: (id) => ipcRenderer.invoke('latex:cloud-download', id),
  cloudGetMeta: (project) => ipcRenderer.invoke('latex:cloud-get-meta', project),
  cloudListMembers: (project) => ipcRenderer.invoke('latex:cloud-list-members', project),
  cloudInvite: (project, options) => ipcRenderer.invoke('latex:cloud-invite', project, options),
  cloudListInvitations: (project) => ipcRenderer.invoke('latex:cloud-list-invitations', project),
  cloudRevokeInvitation: (project, invitationId) => ipcRenderer.invoke('latex:cloud-revoke-invitation', project, invitationId),
  cloudRemoveMember: (project, memberUserId) => ipcRenderer.invoke('latex:cloud-remove-member', project, memberUserId),
  cloudAcceptInvitation: (invitationId, token) => ipcRenderer.invoke('latex:cloud-accept-invitation', invitationId, token),
  cloudMyInvitations: () => ipcRenderer.invoke('latex:cloud-my-invitations'),
  cloudDeclineInvitation: (invitationId) => ipcRenderer.invoke('latex:cloud-decline-invitation', invitationId),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('latex:state-changed', listener);
    return () => ipcRenderer.removeListener('latex:state-changed', listener);
  }
});
