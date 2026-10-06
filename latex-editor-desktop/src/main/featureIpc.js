const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow } = require('electron');

function registerFeatureIpc({ ipcMain, dialog, workspace, history, auth, cloud, openProject }) {
  const shellUrl = pathToFileURL(path.resolve(__dirname, '../renderer/index.html')).toString();
  const owner = (event) => BrowserWindow.fromWebContents(event.sender);
  const project = (value) => {
    if (typeof value !== 'string' || !value) throw new Error('Hãy mở một project trước.');
    return workspace.getProjectLocation(value);
  };
  const handlers = {
    'latex:history-list': (_event, value) => history.list(project(value)),
    'latex:history-save': (_event, value, message) => history.save(project(value), message, auth.status().user || {}),
    'latex:history-diff': (_event, value, hash) => history.diff(project(value), hash),
    'latex:history-restore': async (event, value, hash) => {
      const location = project(value);
      const result = await dialog.showMessageBox(owner(event), {
        type: 'warning', title: 'Khôi phục phiên bản',
        message: 'Khôi phục nội dung project về phiên bản đã chọn?',
        detail: 'Hãy lưu mọi tab bằng Ctrl+S trước khi tiếp tục. App sẽ lưu một bản bảo vệ các file trên ổ đĩa rồi khôi phục. Nội dung chưa lưu trong editor không nằm trong bản bảo vệ.',
        buttons: ['Hủy', 'Lưu bản bảo vệ và khôi phục'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (result.response !== 1) return { canceled: true };
      return history.restore(location, hash, auth.status().user || {});
    },
    'latex:auth-status': () => auth.status(),
    'latex:auth-login': () => auth.login(),
    'latex:auth-logout': () => auth.logout(),
    'latex:cloud-list': () => cloud.list(),
    'latex:cloud-upload': (_event, value) => cloud.upload(project(value)),
    'latex:cloud-download': async (_event, id) => {
      const downloaded = await cloud.download(id);
      await openProject(downloaded.path);
      return downloaded;
    },
    'latex:cloud-get-meta': (_event, value) => cloud.getProjectMeta(project(value)),
    'latex:cloud-list-members': (_event, value) => cloud.listMembers(project(value)),
    'latex:cloud-invite': (_event, value, options) => cloud.invite(project(value), options),
    'latex:cloud-list-invitations': (_event, value) => cloud.listInvitations(project(value)),
    'latex:cloud-revoke-invitation': (_event, value, invitationId) => cloud.revokeInvitation(project(value), invitationId),
    'latex:cloud-accept-invitation': (_event, invitationId, token) => cloud.acceptInvitation(invitationId, token),
    'latex:cloud-my-invitations': () => cloud.myInvitations(),
    'latex:cloud-decline-invitation': (_event, invitationId) => cloud.declineInvitation(invitationId)
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender.getURL() !== shellUrl || event.senderFrame !== event.sender.mainFrame) throw new Error('Yêu cầu không đến từ giao diện ứng dụng.');
      return handler(event, ...args);
    });
  }
}

module.exports = { registerFeatureIpc };
