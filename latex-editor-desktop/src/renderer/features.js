(() => {
  const api = window.latexEditor;
  const $ = (selector) => document.querySelector(selector);
  const historyDialog = $('#history-dialog');
  const accountDialog = $('#account-dialog');
  const shareDialog = $('#share-dialog');
  let state = { project: null };
  let historyProject;
  let shareProject;
  let selectedHash;
  let historyBusy = false;
  let cloudBusy = false;
  let shareBusy = false;
  let selectionRequest = 0;

  function feedback(selector, message, error = false) {
    $(selector).textContent = message;
    $(selector).classList.toggle('is-error', error);
  }
  async function historyAction(task) {
    if (historyBusy) return;
    historyBusy = true;
    for (const selector of ['#history-save', '#history-restore', '#history-refresh']) $(selector).disabled = true;
    feedback('#history-feedback', 'Đang xử lý…');
    try { await task(); }
    catch (error) { feedback('#history-feedback', error.message, true); }
    finally {
      historyBusy = false;
      $('#history-save').disabled = false;
      $('#history-refresh').disabled = false;
      $('#history-restore').disabled = !selectedHash;
    }
  }
  async function loadHistory() {
    const entries = await api.historyList(historyProject.path);
    const container = $('#history-list');
    container.replaceChildren();
    selectedHash = null;
    selectionRequest += 1;
    $('#history-diff').textContent = 'Chọn một phiên bản để xem thay đổi.';
    $('#history-restore').disabled = true;
    if (!entries.length) container.textContent = 'Chưa có phiên bản. Lưu phiên bản đầu tiên ở trên.';
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-entry';
      const name = document.createElement('strong');
      name.textContent = entry.message;
      const meta = document.createElement('small');
      meta.textContent = `${entry.hash.slice(0, 8)} · ${new Date(entry.date).toLocaleString('vi-VN')} · ${entry.author}`;
      button.append(name, meta);
      button.addEventListener('click', async () => {
        if (historyBusy) return;
        selectedHash = entry.hash;
        const request = ++selectionRequest;
        container.querySelectorAll('button').forEach((row) => row.classList.toggle('selected', row === button));
        $('#history-diff').textContent = 'Đang tải thay đổi…';
        $('#history-restore').disabled = true;
        try {
          const diff = await api.historyDiff(historyProject.path, entry.hash);
          if (request !== selectionRequest) return;
          $('#history-diff').textContent = diff;
          $('#history-restore').disabled = false;
        } catch (error) { if (request === selectionRequest) feedback('#history-feedback', error.message, true); }
      });
      container.append(button);
    }
  }

  $('#history-button').addEventListener('click', async () => {
    historyProject = state.project;
    if (!historyProject) return;
    await api.hideEditor();
    historyDialog.showModal();
    $('#history-project-name').textContent = historyProject.name;
    await historyAction(async () => { await loadHistory(); feedback('#history-feedback', ''); });
  });
  $('#history-save-form').addEventListener('submit', (event) => {
    event.preventDefault();
    historyAction(async () => {
      const result = await api.historySave(historyProject.path, $('#history-message').value.trim());
      $('#history-message').value = '';
      await loadHistory();
      feedback('#history-feedback', result.unchanged ? 'Không có thay đổi mới để lưu.' : 'Đã lưu phiên bản.');
    });
  });
  $('#history-refresh').addEventListener('click', () => historyAction(async () => { await loadHistory(); feedback('#history-feedback', 'Đã cập nhật lịch sử.'); }));
  $('#history-restore').addEventListener('click', () => historyAction(async () => {
    if (!selectedHash) return;
    const result = await api.historyRestore(historyProject.path, selectedHash);
    if (!result.canceled) { await loadHistory(); feedback('#history-feedback', `Đã khôi phục. Bản bảo vệ: ${result.backup.slice(0, 8)}.`); }
    else feedback('#history-feedback', 'Đã hủy khôi phục.');
  }));
  $('#history-close').addEventListener('click', () => { if (!historyBusy) historyDialog.close(); });
  historyDialog.addEventListener('cancel', (event) => { if (historyBusy) event.preventDefault(); });
  historyDialog.addEventListener('close', () => { selectionRequest += 1; api.showEditor(); });

  async function refreshInvitationsBadge() {
    try {
      const badge = $('#account-badge');
      if (!badge) return;
      if (!api.cloudMyInvitations) {
        badge.hidden = true;
        return;
      }
      const auth = await api.authStatus();
      if (!auth.signedIn) {
        badge.hidden = true;
        return;
      }
      const invites = await api.cloudMyInvitations();
      if (invites && invites.length > 0) {
        badge.textContent = invites.length;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch {
      // ignore
    }
  }

  function renderAuth(auth) {
    $('#account-label').textContent = auth.signedIn ? 'Đã đăng nhập' : 'Tài khoản';
    $('#account-description').textContent = auth.signedIn
      ? `${auth.user.name} · ${auth.user.email}`
      : auth.configured ? (auth.signingIn ? 'Hoàn tất đăng nhập trong trình duyệt vừa mở.' : 'Đăng nhập để đồng bộ project và lịch sử giữa các máy.')
        : 'Cloud chưa được thiết lập cho bản ứng dụng này. Bạn vẫn có thể dùng project và lịch sử local.';
    $('#google-login').hidden = auth.signedIn;
    $('#google-login').disabled = !auth.configured || auth.signingIn;
    $('#account-logout').hidden = !auth.signedIn && !auth.signingIn;
    $('#account-logout').textContent = auth.signingIn ? 'Hủy đăng nhập' : 'Đăng xuất';
    $('#cloud-section').hidden = !auth.signedIn;
    $('#cloud-upload').disabled = !state.project || cloudBusy;
    if (!auth.signedIn) {
      $('#cloud-projects').replaceChildren();
      const badge = $('#account-badge');
      if (badge) badge.hidden = true;
    } else {
      refreshInvitationsBadge();
    }
  }
  async function cloudAction(task) {
    if (cloudBusy) return;
    cloudBusy = true;
    $('#cloud-upload').disabled = true;
    $('#cloud-refresh').disabled = true;
    feedback('#account-feedback', 'Đang xử lý…');
    try { await task(); }
    catch (error) { feedback('#account-feedback', error.message, true); }
    finally {
      cloudBusy = false;
      $('#cloud-upload').disabled = !state.project;
      $('#cloud-refresh').disabled = false;
    }
  }
  async function loadCloud() {
    if (api.cloudMyInvitations) {
      try {
        const myInvites = await api.cloudMyInvitations();
        const pendingCard = $('#pending-my-invitations');
        const countSpan = $('#my-invitations-count');
        const listDiv = $('#my-invitations-list');
        if (pendingCard && listDiv) {
          if (myInvites && myInvites.length > 0) {
            pendingCard.hidden = false;
            if (countSpan) countSpan.textContent = myInvites.length;
            listDiv.replaceChildren();
            for (const inv of myInvites) {
              const item = document.createElement('div');
              item.className = 'my-invitation-item';
              const info = document.createElement('div');
              info.className = 'member-info';
              const roleName = inv.role === 'editor' ? 'Chỉnh sửa (Editor)' : 'Xem (Viewer)';
              const projTitle = document.createElement('strong');
              projTitle.textContent = inv.projectName || 'Dự án';
              const metaSmall = document.createElement('small');
              metaSmall.textContent = `Mời bởi: ${inv.inviterName || inv.inviterEmail} · Quyền: ${roleName}`;
              info.append(projTitle, metaSmall);

              const actions = document.createElement('div');
              actions.className = 'my-invitation-actions';
              const acceptBtn = document.createElement('button');
              acceptBtn.type = 'button';
              acceptBtn.className = 'primary';
              acceptBtn.textContent = 'Chấp nhận';
              acceptBtn.addEventListener('click', () => cloudAction(async () => {
                const res = await api.cloudAcceptInvitation(inv.id);
                feedback('#account-feedback', `Đã tham gia dự án ${inv.projectName || ''}!`);
                await loadCloud();
                await refreshInvitationsBadge();
                if (res.projectId) {
                  const copy = await api.cloudDownload(res.projectId);
                  feedback('#account-feedback', `Đã tải và mở dự án ${copy.name}.`);
                }
              }));

              const declineBtn = document.createElement('button');
              declineBtn.type = 'button';
              declineBtn.className = 'btn-danger';
              declineBtn.textContent = 'Từ chối';
              declineBtn.addEventListener('click', () => cloudAction(async () => {
                await api.cloudDeclineInvitation(inv.id);
                feedback('#account-feedback', 'Đã từ chối lời mời.');
                await loadCloud();
                await refreshInvitationsBadge();
              }));

              actions.append(acceptBtn, declineBtn);
              item.append(info, actions);
              listDiv.append(item);
            }
          } else {
            pendingCard.hidden = true;
          }
        }
      } catch (err) {
        console.warn('Failed to load my invitations:', err);
      }
    }

    const projects = await api.cloudList();
    const container = $('#cloud-projects');
    container.replaceChildren();
    if (!projects.length) container.textContent = 'Chưa có project trên cloud.';
    for (const project of projects) {
      const row = document.createElement('div');
      row.className = 'cloud-project';
      const text = document.createElement('span');
      const roleText = project.role === 'owner' ? 'Chủ sở hữu' : project.role === 'editor' ? 'Chỉnh sửa' : project.role === 'viewer' ? 'Xem' : '';
      text.textContent = `${project.name} ${roleText ? `(${roleText})` : ''} · ${new Date(project.updatedAt).toLocaleString('vi-VN')}`;
      const download = document.createElement('button');
      download.type = 'button';
      download.textContent = 'Tải bản sao';
      download.addEventListener('click', () => cloudAction(async () => {
        const copy = await api.cloudDownload(project.id);
        feedback('#account-feedback', `Đã tải ${copy.name}, kèm lịch sử phiên bản.`);
      }));
      row.append(text, download);
      container.append(row);
    }
  }
  $('#account-button').addEventListener('click', async () => {
    await api.hideEditor();
    accountDialog.showModal();
    try {
      const auth = await api.authStatus();
      renderAuth(auth);
      feedback('#account-feedback', '');
      if (auth.signedIn) await cloudAction(async () => { await loadCloud(); feedback('#account-feedback', ''); });
    } catch (error) { feedback('#account-feedback', error.message, true); }
  });
  $('#google-login').addEventListener('click', async () => {
    $('#google-login').disabled = true;
    feedback('#account-feedback', 'Đang chờ đăng nhập trong trình duyệt…');
    try {
      renderAuth(await api.login());
      await cloudAction(async () => { await loadCloud(); feedback('#account-feedback', 'Đăng nhập thành công.'); });
    } catch (error) { feedback('#account-feedback', error.message, true); renderAuth(await api.authStatus()); }
  });
  $('#account-logout').addEventListener('click', async () => {
    try {
      const result = await api.logout(); renderAuth(result);
      feedback('#account-feedback', result.warning || 'Đã đăng xuất. File local được giữ nguyên.');
    } catch (error) { feedback('#account-feedback', error.message, true); }
  });
  $('#cloud-upload').addEventListener('click', () => cloudAction(async () => {
    const result = await api.cloudUpload(state.project.path);
    await loadCloud(); feedback('#account-feedback', result.message);
  }));
  $('#cloud-refresh').addEventListener('click', () => cloudAction(async () => { await loadCloud(); feedback('#account-feedback', 'Đã cập nhật danh sách.'); }));
  $('#join-invite-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = $('#join-invite-input').value.trim();
    if (!raw) return;
    const match = raw.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?::([A-Za-z0-9_-]{43}))?/i);
    const inviteId = match ? match[1] : raw;
    const token = match?.[2];
    cloudAction(async () => {
      const result = await api.cloudAcceptInvitation(inviteId, token);
      $('#join-invite-input').value = '';
      feedback('#account-feedback', 'Đã tham gia project! Tải bản sao từ danh sách để làm việc.');
      await loadCloud();
      if (result.projectId) {
        const copy = await api.cloudDownload(result.projectId);
        feedback('#account-feedback', `Đã tham gia và mở project ${copy.name}.`);
      }
    });
  });
  $('#account-close').addEventListener('click', () => accountDialog.close());
  accountDialog.addEventListener('close', () => api.showEditor());

  // --- Share & Team Management ---
  const roleMap = { owner: 'Chủ sở hữu', editor: 'Người chỉnh sửa', viewer: 'Người xem' };

  async function shareAction(task) {
    if (shareBusy) return;
    shareBusy = true;
    $('#share-refresh').disabled = true;
    feedback('#share-feedback', 'Đang xử lý…');
    try { await task(); }
    catch (error) { feedback('#share-feedback', error.message, true); }
    finally {
      shareBusy = false;
      $('#share-refresh').disabled = false;
    }
  }

  async function loadShare() {
    if (!shareProject) return;
    $('#share-project-name').textContent = shareProject.name;
    $('#share-unsynced-banner').hidden = true;
    $('#share-main').hidden = true;
    $('#share-members-list').replaceChildren();
    $('#share-pending-list').replaceChildren();
    $('#share-invite-section').hidden = true;
    $('#share-pending-section').hidden = true;
    $('#share-my-role').textContent = '';
    $('#share-sync-now').hidden = false;
    const openAccountBtn = $('#share-open-account');
    if (openAccountBtn) openAccountBtn.hidden = true;
    const bannerText = $('#share-unsynced-text') || $('#share-unsynced-banner p');
    if (bannerText) bannerText.textContent = 'Project này chưa được đồng bộ lên cloud. Hãy đồng bộ để mời thành viên và phân quyền.';
    feedback('#share-feedback', '');

    let meta = null;
    try {
      meta = await api.cloudGetMeta(shareProject.path);
    } catch (err) {
      if (err.message?.includes('tài khoản hoặc dịch vụ cloud khác')) {
        $('#share-unsynced-banner').hidden = false;
        if (bannerText) bannerText.textContent = 'Project này thuộc quyền sở hữu của tài khoản khác. Nếu bạn được mời, hãy vào mục “Tài khoản & Cloud” để chấp nhận lời mời và tải dự án về làm việc.';
        $('#share-sync-now').hidden = true;
        if (openAccountBtn) openAccountBtn.hidden = false;
        return;
      }
      throw err;
    }

    if (!meta) {
      $('#share-unsynced-banner').hidden = false;
      $('#share-main').hidden = true;
      return;
    }
    $('#share-unsynced-banner').hidden = true;
    $('#share-main').hidden = false;

    const myRole = meta.role || 'viewer';
    $('#share-my-role').textContent = roleMap[myRole] || myRole;
    $('#share-my-role').className = `role-badge ${myRole}`;

    const isOwner = myRole === 'owner';
    $('#share-invite-section').hidden = !isOwner;

    // Members list
    let members = [];
    try {
      members = await api.cloudListMembers(shareProject.path);
    } catch (err) {
      if (err.message?.includes('tài khoản hoặc dịch vụ cloud khác')) {
        $('#share-unsynced-banner').hidden = false;
        if (bannerText) bannerText.textContent = 'Project này thuộc quyền sở hữu của tài khoản khác. Nếu bạn được mời, hãy vào mục “Tài khoản & Cloud” để chấp nhận lời mời và tải dự án về làm việc.';
        $('#share-sync-now').hidden = true;
        if (openAccountBtn) openAccountBtn.hidden = false;
        $('#share-main').hidden = true;
        return;
      }
      if (err.message?.includes('chưa được đồng bộ') || err.message?.includes('Không tìm thấy') || err.status === 404) {
        $('#share-unsynced-banner').hidden = false;
        $('#share-main').hidden = true;
        return;
      }
      throw err;
    }
    $('#share-members-count').textContent = members.length;
    const membersContainer = $('#share-members-list');
    membersContainer.replaceChildren();
    for (const m of members) {
      const item = document.createElement('div');
      item.className = 'member-item';
      const info = document.createElement('div');
      info.className = 'member-info';
      const name = document.createElement('strong');
      name.textContent = `${m.name || m.email} ${m.name ? `(${m.email})` : ''}`;
      const joined = document.createElement('small');
      joined.textContent = `Tham gia: ${new Date(m.joined_at).toLocaleDateString('vi-VN')}`;
      info.append(name, joined);

      const actions = document.createElement('div');
      actions.className = 'member-actions';
      const badge = document.createElement('span');
      badge.className = `role-badge ${m.role}`;
      badge.textContent = roleMap[m.role] || m.role;
      actions.append(badge);

      if (isOwner && (m.role !== 'owner' || members.filter((x) => x.role === 'owner').length > 1)) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = 'Xóa';
        removeBtn.addEventListener('click', () => shareAction(async () => {
          await api.cloudRemoveMember(shareProject.path, m.id);
          feedback('#share-feedback', `Đã xóa thành viên ${m.name || m.email}.`);
          await loadShare();
        }));
        actions.append(removeBtn);
      }
      item.append(info, actions);
      membersContainer.append(item);
    }

    // Pending invitations list (owner only)
    if (isOwner) {
      try {
        const invitations = await api.cloudListInvitations(shareProject.path);
        const pending = invitations.filter((inv) => inv.status === 'pending');
        $('#share-pending-count').textContent = pending.length;
        $('#share-pending-section').hidden = pending.length === 0;
        const pendingContainer = $('#share-pending-list');
        pendingContainer.replaceChildren();
        for (const inv of pending) {
          const item = document.createElement('div');
          item.className = 'pending-item';
          const info = document.createElement('div');
          info.className = 'member-info';
          const title = document.createElement('strong');
          title.textContent = inv.email || 'Mã/Link mời';
          const expire = document.createElement('small');
          expire.textContent = `Hết hạn: ${new Date(inv.expires_at).toLocaleDateString('vi-VN')}`;
          info.append(title, expire);

          const actions = document.createElement('div');
          actions.className = 'member-actions';
          const badge = document.createElement('span');
          badge.className = `role-badge ${inv.role}`;
          badge.textContent = roleMap[inv.role] || inv.role;
          actions.append(badge);

          const revokeBtn = document.createElement('button');
          revokeBtn.type = 'button';
          revokeBtn.className = 'btn-danger';
          revokeBtn.textContent = 'Thu hồi';
          revokeBtn.addEventListener('click', () => shareAction(async () => {
            await api.cloudRevokeInvitation(shareProject.path, inv.id);
            feedback('#share-feedback', 'Đã thu hồi lời mời.');
            await loadShare();
          }));
          actions.append(revokeBtn);
          item.append(info, actions);
          pendingContainer.append(item);
        }
      } catch (err) {
        if (err.message?.includes('tài khoản hoặc dịch vụ cloud khác')) {
          $('#share-unsynced-banner').hidden = false;
          if (bannerText) bannerText.textContent = 'Project này thuộc quyền sở hữu của tài khoản khác. Nếu bạn được mời, hãy vào mục “Tài khoản & Cloud” để chấp nhận lời mời và tải dự án về làm việc.';
          $('#share-sync-now').hidden = true;
          if (openAccountBtn) openAccountBtn.hidden = false;
          $('#share-main').hidden = true;
          return;
        }
        throw err;
      }
    } else {
      $('#share-pending-section').hidden = true;
    }
  }

  $('#share-button').addEventListener('click', async () => {
    shareProject = state.project;
    if (!shareProject) return;
    const auth = await api.authStatus();
    if (!auth.signedIn) {
      await api.hideEditor();
      accountDialog.showModal();
      renderAuth(auth);
      feedback('#account-feedback', 'Hãy đăng nhập bằng Google trước khi sử dụng tính năng chia sẻ.');
      return;
    }
    await api.hideEditor();
    shareDialog.showModal();
    feedback('#share-feedback', '');
    $('#share-link-result').hidden = true;
    await shareAction(async () => { await loadShare(); });
  });

  $('#share-sync-now').addEventListener('click', () => shareAction(async () => {
    feedback('#share-feedback', 'Đang đồng bộ project lên cloud…');
    await api.cloudUpload(shareProject.path);
    feedback('#share-feedback', 'Đã đồng bộ project thành công!');
    await loadShare();
  }));

  $('#share-open-account')?.addEventListener('click', () => {
    shareDialog.close();
    $('#account-button').click();
  });

  $('#share-email-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = $('#share-invite-email').value.trim();
    const role = $('#share-invite-role').value;
    if (!email) return;
    shareAction(async () => {
      const result = await api.cloudInvite(shareProject.path, { email, role });
      $('#share-invite-email').value = '';
      feedback('#share-feedback', result.delivery?.sent
        ? `Đã gửi email mời tới ${email}.`
        : `Đã tạo lời mời cho ${email}, nhưng dịch vụ gửi email chưa sẵn sàng. Người đó vẫn thấy lời mời khi đăng nhập ứng dụng.`, !result.delivery?.sent);
      await loadShare();
    });
  });

  $('#share-create-link').addEventListener('click', () => shareAction(async () => {
    const role = $('#share-link-role').value;
    const result = await api.cloudInvite(shareProject.path, { role });
    const inv = result.invitation;
    $('#share-link-input').value = inv.token ? `${inv.id}:${inv.token}` : inv.id;
    $('#share-link-result').hidden = false;
    feedback('#share-feedback', 'Đã tạo mã mời! Sao chép mã bên dưới để gửi.');
    await loadShare();
  }));

  $('#share-copy-link').addEventListener('click', async () => {
    const val = $('#share-link-input').value;
    if (val) {
      await navigator.clipboard.writeText(val);
      feedback('#share-feedback', 'Đã sao chép mã mời vào bộ nhớ tạm.');
    }
  });

  $('#share-refresh').addEventListener('click', () => shareAction(async () => {
    await loadShare();
    feedback('#share-feedback', 'Đã làm mới thông tin.');
  }));

  $('#share-close').addEventListener('click', () => shareDialog.close());
  shareDialog.addEventListener('close', () => api.showEditor());

  function update(next) {
    state = next;
    const canUse = Boolean(next.project && next.phase === 'ready');
    $('#history-button').disabled = !canUse;
    $('#share-button').disabled = !canUse;
    if (next.auth) renderAuth(next.auth);
  }
  api.onStateChanged(update);
  api.getState().then(update).catch((error) => feedback('#account-feedback', error.message, true));
})();
