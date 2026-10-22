const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, nativeImage } = require('electron');
const { validatePreviewPng } = require('./PersonalTemplateManager');

function registerFeatureIpc({ ipcMain, dialog, workspace, history, auth, cloud, collaboration, openProject, clipboard }) {
  const shellUrl = pathToFileURL(path.resolve(__dirname, '../renderer/index.html')).toString();
  const owner = (event) => BrowserWindow?.fromWebContents?.(event.sender) || null;
  const project = (value) => {
    if (typeof value !== 'string' || !value) throw new Error('Hãy mở một project trước.');
    return workspace.getProjectLocation(value);
  };
  const syncSavedProject = async (location, result) => {
    if (!auth.status().signedIn) {
      return { ...result, cloudSynced: false, cloudWarning: 'Phiên bản đã lưu trên máy. Hãy đăng nhập để đồng bộ lên cloud.' };
    }
    try {
      const synced = await cloud.upload(location);
      return { ...result, cloudSynced: true, cloudProject: synced.project || null };
    } catch (error) {
      return { ...result, cloudSynced: false, cloudWarning: `Phiên bản đã lưu trên máy nhưng chưa đồng bộ được lên cloud: ${error.message}` };
    }
  };
  const handlers = {
    'latex:clipboard-write': (_event, value) => {
      if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
        throw new Error('Nội dung sao chép không hợp lệ.');
      }
      if (!clipboard?.writeText) throw new Error('Clipboard chưa sẵn sàng.');
      clipboard.writeText(value);
      return true;
    },
    'latex:history-list': async (_event, value) => {
      const location = project(value);
      let cloudUpdated = false;
      let cloudWarning = null;
      if (auth.status().signedIn) {
        try { cloudUpdated = Boolean((await cloud.refreshHistory(location)).updated); }
        catch (error) { cloudWarning = `Không làm mới được lịch sử từ cloud: ${error.message}`; }
      }
      return { entries: await history.list(location), cloudUpdated, cloudWarning };
    },
    'latex:history-save': async (_event, value, message) => {
      const location = project(value);
      const result = await history.save(location, message, auth.status().user || {});
      return syncSavedProject(location, result);
    },
    'latex:history-diff': (_event, value, hash) => history.diff(project(value), hash),
    'latex:history-restore': async (event, value, hash) => {
      const location = project(value);
      const reset = collaboration?.resetCapability(location) || { required: false, ready: true, participants: 0 };
      if (!reset.ready) throw new Error(reset.error);
      const confirmation = await dialog.showMessageBox(owner(event), {
        type: 'warning', title: 'Khôi phục phiên bản',
        message: 'Khôi phục nội dung project về phiên bản đã chọn?',
        detail: reset.required
          ? `Hãy lưu mọi tab bằng Ctrl+S. App sẽ tạo bản bảo vệ, khôi phục snapshot rồi thay draft cộng tác cho ${reset.participants || 1} người đang online. Thay đổi chưa lưu sẽ mất.`
          : 'Hãy lưu mọi tab bằng Ctrl+S trước khi tiếp tục. App sẽ lưu một bản bảo vệ các file trên ổ đĩa rồi khôi phục. Nội dung chưa lưu trong editor không nằm trong bản bảo vệ.',
        buttons: ['Hủy', reset.required ? 'Khôi phục và thay draft' : 'Lưu bản bảo vệ và khôi phục'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      const restored = await history.restore(location, hash, auth.status().user || {});
      const draft = await collaboration?.resetDrafts(location);
      return syncSavedProject(location, { ...restored, draftReset: Boolean(draft?.reset) });
    },
    'latex:auth-status': () => auth.status(),
    'latex:auth-login': () => auth.login(),
    'latex:cloud-storage': async () => (await auth.request('/v1/me/storage')).json(),
    'latex:auth-delete-account': async (event) => {
      const user = auth.status().user;
      if (!user) throw new Error('Hãy đăng nhập trước.');
      const confirmation = await dialog.showMessageBox(owner(event), {
        type: 'warning', title: 'Xóa tài khoản LaTeX Editor',
        message: `Xóa tài khoản ${user.email}?`,
        detail: 'Tất cả phiên đăng nhập sẽ bị thu hồi. Project mà bạn là chủ sở hữu duy nhất (kể cả project đã chia sẻ), template và dữ liệu cloud của bạn sẽ được xóa. Project có chủ sở hữu khác được giữ lại. Bản local trên các máy vẫn còn. Backup vận hành được lưu riêng và không bị xóa ngay cùng tài khoản. Không thể hoàn tác.',
        buttons: ['Hủy', 'Xóa tài khoản'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      const response = await auth.request('/v1/me', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE', email: user.email }) });
      const result = await response.json();
      await auth.logout(false);
      workspace.clearSessionState?.();
      collaboration?.close();
      await openProject?.(null);
      return { ...result, canceled: false };
    },
    'latex:auth-logout': async () => {
      const result = await auth.logout();
      if (workspace?.clearSessionState) workspace.clearSessionState();
      if (collaboration?.close) collaboration.close();
      if (openProject) {
        try { await openProject(null); } catch {}
      }
      return result;
    },
    'latex:cloud-list': () => cloud.list(),
    'latex:cloud-upload': (_event, value) => cloud.upload(project(value)),
    // Downloading and opening are deliberately separate operations. The
    // renderer may still have a modal dialog open while this IPC call runs;
    // attaching the native WebContentsView at that point can cover the modal
    // and leave the shell looking like a frozen white window.
    'latex:cloud-download': (_event, id) => cloud.download(id),
    'latex:cloud-get-meta': (_event, value) => cloud.getProjectMeta(project(value)),
    'latex:cloud-list-members': (_event, value) => cloud.listMembers(project(value)),
    'latex:cloud-invite': (_event, value, options) => cloud.invite(project(value), options),
    'latex:cloud-list-invitations': (_event, value) => cloud.listInvitations(project(value)),
    'latex:cloud-revoke-invitation': (_event, value, invitationId) => cloud.revokeInvitation(project(value), invitationId),
    'latex:cloud-remove-member': (_event, value, memberUserId) => cloud.removeMember(project(value), memberUserId),
    'latex:cloud-accept-invitation': (_event, invitationId, token) => cloud.acceptInvitation(invitationId, token),
    'latex:cloud-my-invitations': () => cloud.myInvitations(),
    'latex:cloud-decline-invitation': (_event, invitationId) => cloud.declineInvitation(invitationId),
    'latex:cloud-delete-project': async (event, value) => {
      const location = project(value);
      const confirmation = await dialog.showMessageBox(owner(event), {
        type: 'warning',
        title: 'Xóa project trên Cloud',
        message: 'Xác nhận xóa project này khỏi Cloud?',
        detail: 'Dữ liệu trên Cloud (bao gồm Git bundle, phòng cộng tác và danh sách thành viên) sẽ bị xóa vĩnh viễn. Mã nguồn và lịch sử cục bộ trên máy tính của bạn sẽ KHÔNG bị xóa.',
        buttons: ['Hủy', 'Xóa khỏi Cloud'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      if (collaboration && collaboration.project === location) {
        collaboration.close();
      }
      const result = await cloud.deleteProject(location);
      return { ...result, canceled: false };
    },
    'latex:cloud-delete-by-id': async (event, id, projectName) => {
      const confirmation = await dialog.showMessageBox(owner(event), {
        type: 'warning',
        title: 'Xóa project trên Cloud',
        message: `Xác nhận xóa project "${projectName || id}" khỏi Cloud?`,
        detail: 'Dữ liệu dự án trên Cloud (Git bundle, phòng cộng tác và danh sách thành viên) sẽ bị xóa vĩnh viễn.',
        buttons: ['Hủy', 'Xóa khỏi Cloud'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      const result = await cloud.deleteProjectById(id);
      return { ...result, canceled: false };
    },
    'latex:cloud-publication-get': (_event, value) => cloud.getPublication(project(value)),
    'latex:cloud-publication-publish': (_event, value, expiresInDays) => cloud.publishPdf(project(value), expiresInDays),
    'latex:cloud-publication-revoke': async (event, value) => {
      const location = project(value);
      const confirmation = await dialog.showMessageBox(owner(event), {
        type: 'warning', title: 'Thu hồi link PDF',
        message: 'Thu hồi link xem PDF công khai?',
        detail: 'Người đang giữ link sẽ không thể mở PDF nữa. Source và lịch sử project không bị ảnh hưởng.',
        buttons: ['Hủy', 'Thu hồi link'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      return { ...(await cloud.revokePublication(location)), canceled: false };
    },
    'latex:template-cloud-list': () => cloud.listCloudTemplates(),
    'latex:template-update-local': (_event, templateId, changes) => workspace.personalTemplates.updateMetadata(templateId, changes),
    'latex:template-choose-preview': async (event) => {
      const result = await dialog.showOpenDialog(owner(event), {
        title: 'Chọn ảnh xem trước template', properties: ['openFile'],
        filters: [{ name: 'Ảnh PNG (tối đa 2 MiB)', extensions: ['png'] }]
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const file = result.filePaths[0];
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Hãy chọn ảnh PNG tối đa 2 MiB.');
      const bytes = validatePreviewPng(fs.readFileSync(file));
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('Không đọc được ảnh PNG đã chọn.');
      return `data:image/png;base64,${bytes.toString('base64')}`;
    },
    'latex:template-cloud-upload': (_event, templateId) => cloud.uploadTemplate(templateId),
    'latex:template-cloud-download': (_event, templateId) => cloud.downloadTemplate(templateId),
    'latex:template-cloud-delete': async (event, templateId, templateName) => {
      const confirmation = await dialog.showMessageBox(owner(event), {
        type: 'warning',
        title: 'Xóa template trên Cloud',
        message: `Xác nhận xóa template "${templateName || templateId}" khỏi Cloud?`,
        detail: 'File mẫu trên Cloudflare R2 sẽ bị xóa. Bản mẫu trên máy tính của bạn sẽ KHÔNG bị xóa.',
        buttons: ['Hủy', 'Xóa khỏi Cloud'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      const result = await cloud.deleteCloudTemplate(templateId);
      return { ...result, canceled: false };
    },
    'latex:template-cloud-sync-all': () => cloud.syncAllTemplates(),
    'latex:template-delete-local': async (event, templateId, templateName) => {
      const confirmation = await dialog.showMessageBox(owner(event), {
        type: 'warning',
        title: 'Xóa template cá nhân',
        message: `Xác nhận xóa template "${templateName || templateId}" khỏi máy tính?`,
        detail: 'Thư mục mẫu trên máy sẽ bị xóa vĩnh viễn.',
        buttons: ['Hủy', 'Xóa'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (confirmation.response !== 1) return { canceled: true };
      const result = workspace.deletePersonalTemplate(templateId);
      return { ...result, canceled: false };
    }
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
