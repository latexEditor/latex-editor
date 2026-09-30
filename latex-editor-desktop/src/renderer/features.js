(() => {
  const api = window.latexEditor;
  const $ = (selector) => document.querySelector(selector);
  const historyDialog = $('#history-dialog');
  const accountDialog = $('#account-dialog');
  let state = { project: null };
  let historyProject;
  let selectedHash;
  let historyBusy = false;
  let cloudBusy = false;
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
    if (!auth.signedIn) $('#cloud-projects').replaceChildren();
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
    const projects = await api.cloudList();
    const container = $('#cloud-projects');
    container.replaceChildren();
    if (!projects.length) container.textContent = 'Chưa có project trên cloud.';
    for (const project of projects) {
      const row = document.createElement('div');
      row.className = 'cloud-project';
      const text = document.createElement('span');
      text.textContent = `${project.name} · ${new Date(project.updatedAt).toLocaleString('vi-VN')}`;
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
  $('#account-close').addEventListener('click', () => accountDialog.close());
  accountDialog.addEventListener('close', () => api.showEditor());
  function update(next) { state = next; $('#history-button').disabled = !next.project || next.phase !== 'ready'; if (next.auth) renderAuth(next.auth); }
  api.onStateChanged(update);
  api.getState().then(update).catch((error) => feedback('#account-feedback', error.message, true));
})();
