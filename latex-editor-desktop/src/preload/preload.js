const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latexEditor', {
  getState: () => ipcRenderer.invoke('latex:get-state'),
  listProjects: () => ipcRenderer.invoke('latex:list-projects'),
  listTemplates: () => ipcRenderer.invoke('latex:list-templates'),
  importTemplate: (name) => ipcRenderer.invoke('latex:import-template', name),
  saveProjectAsTemplate: (projectPath, name) => ipcRenderer.invoke('latex:save-project-template', projectPath, name),
  forgetProject: (projectPath) => ipcRenderer.invoke('latex:forget-project', projectPath),
  revealProject: (projectPath) => ipcRenderer.invoke('latex:reveal-project', projectPath),
  createProject: (name, templateId) => ipcRenderer.invoke('latex:create-project', name, templateId),
  chooseProject: () => ipcRenderer.invoke('latex:choose-project'),
  openProject: (projectPath) => ipcRenderer.invoke('latex:open-project', projectPath),
  closeProject: (projectPath) => ipcRenderer.invoke('latex:close-project', projectPath),
  hideEditor: () => ipcRenderer.invoke('latex:hide-editor'),
  showEditor: () => ipcRenderer.invoke('latex:show-editor'),
  togglePresencePopover: (anchor) => ipcRenderer.invoke('latex:toggle-presence-popover', anchor),
  onPresencePopoverClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('latex:presence-popover-closed', listener);
    return () => ipcRenderer.removeListener('latex:presence-popover-closed', listener);
  },
  getRuntimeStatus: () => ipcRenderer.invoke('latex:get-runtime-status'),
  historyList: (project) => ipcRenderer.invoke('latex:history-list', project),
  historySave: (project, message) => ipcRenderer.invoke('latex:history-save', project, message),
  historyDiff: (project, hash) => ipcRenderer.invoke('latex:history-diff', project, hash),
  historyRestore: (project, hash) => ipcRenderer.invoke('latex:history-restore', project, hash),
  authStatus: () => ipcRenderer.invoke('latex:auth-status'),
  login: () => ipcRenderer.invoke('latex:auth-login'),
  logout: () => ipcRenderer.invoke('latex:auth-logout'),
  deleteAccount: () => ipcRenderer.invoke('latex:auth-delete-account'),
  cloudStorage: () => ipcRenderer.invoke('latex:cloud-storage'),
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
  cloudDeleteProject: (project) => ipcRenderer.invoke('latex:cloud-delete-project', project),
  cloudDeleteById: (id, name) => ipcRenderer.invoke('latex:cloud-delete-by-id', id, name),
  templateCloudList: () => ipcRenderer.invoke('latex:template-cloud-list'),
  templateCloudUpload: (templateId) => ipcRenderer.invoke('latex:template-cloud-upload', templateId),
  templateCloudDownload: (templateId) => ipcRenderer.invoke('latex:template-cloud-download', templateId),
  templateCloudDelete: (templateId, templateName) => ipcRenderer.invoke('latex:template-cloud-delete', templateId, templateName),
  templateCloudSyncAll: () => ipcRenderer.invoke('latex:template-cloud-sync-all'),
  templateDeleteLocal: (templateId, templateName) => ipcRenderer.invoke('latex:template-delete-local', templateId, templateName),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('latex:state-changed', listener);
    return () => ipcRenderer.removeListener('latex:state-changed', listener);
  }
});
