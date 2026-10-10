const api = window.latexEditor;
const newDialog = document.querySelector('#new-dialog');
const runtimeDialog = document.querySelector('#runtime-dialog');
const recentDialog = document.querySelector('#recent-dialog');
const nameInput = document.querySelector('#new-project-name');
const errorBox = document.querySelector('#dialog-error');
let currentState = { phase: 'starting', project: null };
let runtimeStatus;
let recentProjects = [];
let creatingProject = false;
let recentRequest = 0;
let projectTemplates = [];

const normalizeTemplateSearch = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

function updateTemplateNote() {
  const selected = document.querySelector('input[name="project-template"]:checked')?.value;
  const template = projectTemplates.find((item) => item.id === selected);
  document.querySelector('#create-confirm').disabled = creatingProject || !template;
  const note = document.querySelector('#template-note');
  if (!template) { note.textContent = ''; return; }
  const engine = template.engine === 'xelatex' ? 'XeLaTeX' : 'pdfLaTeX';
  const missing = runtimeStatus && !runtimeStatus.tools.some((tool) => tool.name === template.engine && tool.available && tool.usable !== false);
  note.textContent = `${template.name} · ${engine}. ` + (missing
    ? `Chưa tìm thấy ${engine} trên máy. Bạn vẫn có thể tạo project, nhưng cần cài compiler này để build.`
    : (template.engine === 'xelatex' ? 'Hỗ trợ tiếng Việt, dùng font Latin Modern đi kèm bộ TeX. ' : '') + 'Lần build đầu có thể cần tải thêm gói LaTeX.');
}

function filterTemplates() {
  const query = normalizeTemplateSearch(document.querySelector('#template-search').value.trim());
  const category = document.querySelector('#template-category').value;
  const visible = [];
  for (const card of document.querySelectorAll('.template-option')) {
    const template = projectTemplates.find((item) => item.id === card.querySelector('input').value);
    card.hidden = Boolean(category && template.category !== category) || !normalizeTemplateSearch(`${template.name} ${template.description} ${template.language} ${template.engine}`).includes(query);
    if (!card.hidden) visible.push(card.querySelector('input'));
  }
  if (!visible.some((radio) => radio.checked)) {
    for (const radio of document.querySelectorAll('input[name="project-template"]')) radio.checked = false;
    if (visible.length) visible[0].checked = true;
  }
  document.querySelector('#template-count').textContent = `${visible.length} / ${projectTemplates.length} mẫu`;
  document.querySelector('#template-empty').hidden = visible.length > 0;
  updateTemplateNote();
}

async function refreshRecentProjects() {
  const request = ++recentRequest;
  const projects = await api.listProjects();
  if (request !== recentRequest) return;
  recentProjects = projects;
  renderRecentProjects();
}

function renderRecentProjects() {
  const query = document.querySelector('#project-search').value.trim().toLocaleLowerCase('vi');
  const matches = recentProjects.filter((project) => (
    `${project.name} ${project.path}`.toLocaleLowerCase('vi').includes(query)
  ));
  renderProjectList(document.querySelector('#recent-project-list'), matches, '#recent-error');
  renderProjectList(document.querySelector('#welcome-project-list'), recentProjects.slice(0, 5), '#welcome-error');
}

function renderProjectList(container, projects, errorSelector) {
  container.replaceChildren();
  if (!projects.length) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = recentProjects.length ? 'Không tìm thấy project phù hợp.' : 'Chưa có project trong lịch sử.';
    container.append(empty);
    return;
  }
  for (const project of projects) {
    const row = document.createElement('div');
    row.className = `recent-project${project.exists ? '' : ' missing'}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'recent-project-open';
    open.disabled = !project.exists || currentState.phase !== 'ready';
    open.title = project.path;
    const name = document.createElement('strong');
    name.textContent = project.name;
    const location = document.createElement('span');
    location.textContent = project.path;
    const status = document.createElement('small');
    status.textContent = !project.exists ? 'Không tìm thấy thư mục' : (
      samePath(project.path, currentState.project?.path) ? 'Đang mở' : 'Mở project'
    );
    open.append(name, location, status);
    open.addEventListener('click', async () => {
      open.disabled = true;
      document.querySelector(errorSelector).textContent = '';
      try {
        await api.openProject(project.path);
        if (recentDialog.open) recentDialog.close();
      } catch (error) {
        document.querySelector(errorSelector).textContent = error.message;
      } finally {
        open.disabled = !project.exists || currentState.phase !== 'ready';
        await refreshRecentProjects().catch((error) => { document.querySelector(errorSelector).textContent = error.message; });
      }
    });
    const actions = document.createElement('div');
    actions.className = 'recent-project-actions';
    for (const action of [
      { label: 'Vị trí', title: `Mở thư mục ${project.name}`, disabled: !project.exists, run: () => api.revealProject(project.path) },
      { label: 'Bỏ', title: `Bỏ ${project.name} khỏi lịch sử (giữ nguyên file)`, run: async () => {
        await api.forgetProject(project.path);
        await refreshRecentProjects();
      } }
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.title = action.title;
      button.setAttribute('aria-label', action.title);
      button.disabled = Boolean(action.disabled);
      button.addEventListener('click', async () => {
        button.disabled = true;
        document.querySelector(errorSelector).textContent = '';
        try { await action.run(); }
        catch (error) { document.querySelector(errorSelector).textContent = error.message; }
        finally { button.disabled = Boolean(action.disabled); }
      });
      actions.append(button);
    }
    row.append(open, actions);
    container.append(row);
  }
}

async function loadTemplates() {
  projectTemplates = await api.listTemplates();
  document.querySelector('#template-search').value = '';
  const categories = document.querySelector('#template-category');
  categories.replaceChildren(new Option('Tất cả', ''));
  for (const category of new Set(projectTemplates.map((item) => item.category))) categories.add(new Option(category, category));
  const container = document.querySelector('#template-options');
  container.replaceChildren();
  for (const [index, template] of projectTemplates.entries()) {
    const label = document.createElement('label');
    label.className = 'template-option';
    const preview = document.createElement('span');
    preview.className = 'template-preview';
    const image = document.createElement('img');
    image.src = new URL(`../../resources/templates/${encodeURIComponent(template.id)}/preview.png`, window.location.href).href;
    image.alt = `Xem trước mẫu ${template.name}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    preview.append(image);
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'project-template';
    radio.value = template.id;
    radio.checked = index === 0;
    const content = document.createElement('span');
    content.className = 'template-content';
    const name = document.createElement('strong');
    name.textContent = template.name;
    const description = document.createElement('small');
    description.textContent = template.description;
    const metadata = document.createElement('small');
    metadata.className = 'template-metadata';
    metadata.textContent = `${template.language} · ${template.engine === 'xelatex' ? 'XeLaTeX' : 'pdfLaTeX'}`;
    content.append(name, description, metadata);
    radio.addEventListener('change', updateTemplateNote);
    label.append(preview, radio, content);
    container.append(label);
  }
  filterTemplates();
}

document.querySelector('#template-search').addEventListener('input', filterTemplates);
document.querySelector('#template-category').addEventListener('change', filterTemplates);

function samePath(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function renderProjectTabs(projects, activeProject) {
  const tabs = document.querySelector('#project-tabs');
  tabs.replaceChildren();
  for (const project of projects) {
    const tab = document.createElement('div');
    tab.className = `project-tab${samePath(project.path, activeProject?.path) ? ' active' : ''}`;
    tab.title = project.path;

    const openButton = document.createElement('button');
    openButton.className = 'project-tab-open';
    openButton.type = 'button';
    const symbol = document.createElement('span');
    symbol.className = 'project-symbol';
    symbol.textContent = 'Tₑ';
    const name = document.createElement('span');
    name.className = 'project-tab-name';
    name.textContent = project.name;
    openButton.append(symbol, name);
    openButton.addEventListener('click', async () => {
      if (samePath(project.path, currentState.project?.path)) return;
      try { await api.openProject(project.path); } catch (error) { window.alert(error.message); }
    });

    const closeButton = document.createElement('button');
    closeButton.className = 'project-tab-close';
    closeButton.type = 'button';
    closeButton.title = `Đóng ${project.name}`;
    closeButton.setAttribute('aria-label', `Đóng project ${project.name}`);
    closeButton.textContent = '×';
    closeButton.addEventListener('click', async () => {
      try { await api.closeProject(project.path); } catch (error) { window.alert(error.message); }
    });

    tab.append(openButton, closeButton);
    tabs.append(tab);
  }
}

function renderState(next) {
  currentState = next;
  const ready = next.phase === 'ready';
  renderProjectTabs(next.openProjects || [], next.project);
  document.querySelector('#empty-workspace').hidden = Boolean(next.project);
  document.querySelector('#status-dot').className = `dot ${ready ? 'ok' : 'checking'}`;
  document.querySelector('#status-text').textContent = ready ? 'Editor sẵn sàng' : 'Đang kết nối…';
  for (const id of ['new-project-location', 'recent-project-location']) {
    document.getElementById(id).textContent = next.projectsDir || '';
  }
  for (const id of ['new-project', 'open-project', 'recent-projects', 'welcome-new', 'welcome-open']) {
    document.getElementById(id).disabled = !ready;
  }
  refreshRecentProjects().catch((error) => { document.querySelector('#welcome-error').textContent = error.message; });
}

async function inspectRuntime() {
  runtimeStatus = await api.getRuntimeStatus();
  document.querySelector('#runtime-dot').className = `dot ${runtimeStatus.canBuild ? 'ok' : 'bad'}`;
  document.querySelector('#runtime-label').textContent = runtimeStatus.canBuild
    ? `${runtimeStatus.distribution} sẵn sàng`
    : 'Thiếu LaTeX runtime';
}

document.querySelector('#new-project').addEventListener('click', async () => {
  errorBox.textContent = '';
  nameInput.value = '';
  document.querySelector('#create-confirm').disabled = true;
  document.querySelector('#template-options').replaceChildren();
  try {
    await api.hideEditor();
    newDialog.showModal();
    await loadTemplates();
    if (newDialog.open) nameInput.focus();
  } catch (error) { errorBox.textContent = error.message; }
});
document.querySelector('#create-cancel').addEventListener('click', () => newDialog.close());
newDialog.addEventListener('cancel', (event) => { if (creatingProject) event.preventDefault(); });
newDialog.addEventListener('close', async () => {
  await api.showEditor();
});
document.querySelector('#open-project').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api.chooseProject();
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.focus();
  }
});
document.querySelector('#new-project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (creatingProject) return;
  const button = document.querySelector('#create-confirm');
  const cancel = document.querySelector('#create-cancel');
  try {
    const name = nameInput.value.trim();
    if (!name) throw new Error('Hãy nhập tên project.');
    const templateId = document.querySelector('input[name="project-template"]:checked')?.value;
    if (!templateId) throw new Error('Hãy chọn mẫu tài liệu.');
    creatingProject = true;
    button.disabled = true;
    cancel.disabled = true;
    button.textContent = 'Đang tạo…';
    const project = await api.createProject(name, templateId);
    newDialog.close();
    if (project.cloudWarning) window.alert(project.cloudWarning);
  } catch (error) { errorBox.textContent = error.message; }
  finally {
    creatingProject = false;
    updateTemplateNote();
    cancel.disabled = false;
    button.textContent = 'Tạo project';
  }
});

document.querySelector('#recent-projects').addEventListener('click', async () => {
  document.querySelector('#recent-error').textContent = '';
  document.querySelector('#project-search').value = '';
  try {
    await api.hideEditor();
    recentDialog.showModal();
    await refreshRecentProjects();
    if (recentDialog.open) document.querySelector('#project-search').focus();
  } catch (error) { document.querySelector('#recent-error').textContent = error.message; }
});
recentDialog.addEventListener('close', () => api.showEditor());
document.querySelector('#recent-close').addEventListener('click', () => recentDialog.close());
document.querySelector('#project-search').addEventListener('input', renderRecentProjects);
document.querySelector('#reveal-projects-root').addEventListener('click', async () => {
  try { await api.revealProject(); }
  catch (error) { document.querySelector('#recent-error').textContent = error.message; }
});
document.querySelector('#welcome-open').addEventListener('click', () => document.querySelector('#open-project').click());
document.querySelector('#welcome-new').addEventListener('click', () => document.querySelector('#new-project').click());
document.querySelector('#runtime-details').addEventListener('click', async () => {
  if (!runtimeStatus) return;
  const content = document.querySelector('#runtime-content');
  content.replaceChildren();
  for (const tool of runtimeStatus.tools) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    const name = document.createElement('strong');
    name.textContent = tool.name;
    const value = document.createElement('span');
    value.textContent = tool.available
      ? `${tool.path}${tool.usable === false ? ` — ${tool.reason}` : ''}`
      : 'Không tìm thấy';
    value.title = value.textContent;
    row.append(name, value);
    content.append(row);
  }
  if (runtimeStatus.recommendation) {
    const help = document.createElement('p');
    help.className = 'runtime-help';
    help.textContent = runtimeStatus.recommendation;
    content.append(help);
  }
  await api.hideEditor();
  runtimeDialog.showModal();
});
runtimeDialog.addEventListener('close', async () => {
  await api.showEditor();
});

api.onStateChanged(renderState);
Promise.all([api.getState(), inspectRuntime()]).then(([initialState]) => renderState(initialState))
  .catch((error) => { document.querySelector('#status-text').textContent = error.message; });
