const api = window.latexEditor;
const projectMenu = document.querySelector('#project-menu');
const projectMenuButton = document.querySelector('#project-menu-button');
const projectList = document.querySelector('#project-list');
const newDialog = document.querySelector('#new-dialog');
const runtimeDialog = document.querySelector('#runtime-dialog');
const nameInput = document.querySelector('#new-project-name');
const errorBox = document.querySelector('#dialog-error');
let currentState = { phase: 'starting', project: null };
let runtimeStatus;

function shortPath(value) {
  return value.length > 38 ? `…${value.slice(-37)}` : value;
}

function closeProjectMenu() {
  projectMenu.hidden = true;
  projectMenuButton.setAttribute('aria-expanded', 'false');
}

function renderState(next) {
  currentState = next;
  const ready = next.phase === 'ready';
  document.querySelector('#project-name').textContent = next.project?.name || 'Chọn project';
  document.querySelector('#status-dot').className = `dot ${ready ? 'ok' : 'checking'}`;
  document.querySelector('#status-text').textContent = ready ? 'Editor sẵn sàng' : 'Đang kết nối…';
  renderProjects();
}

async function renderProjects() {
  const projects = (await api.listProjects()).filter((project) => project.exists);
  projectList.replaceChildren();
  if (!projects.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Chưa có project gần đây.';
    projectList.append(empty);
    return;
  }
  for (const project of projects) {
    const button = document.createElement('button');
    button.className = `project-item${currentState.project?.path === project.path ? ' active' : ''}`;
    const symbol = document.createElement('span');
    symbol.className = 'project-symbol';
    symbol.textContent = 'Tₑ';
    const meta = document.createElement('span');
    meta.className = 'project-meta';
    const title = document.createElement('strong');
    title.textContent = project.name;
    const location = document.createElement('small');
    location.textContent = shortPath(project.path);
    meta.append(title, location);
    button.append(symbol, meta);
    button.title = project.path;
    button.addEventListener('click', async () => {
      closeProjectMenu();
      try { await api.openProject(project.path); } catch (error) { window.alert(error.message); }
    });
    projectList.append(button);
  }
}

async function inspectRuntime() {
  runtimeStatus = await api.getRuntimeStatus();
  document.querySelector('#runtime-dot').className = `dot ${runtimeStatus.canBuild ? 'ok' : 'bad'}`;
  document.querySelector('#runtime-label').textContent = runtimeStatus.canBuild
    ? `${runtimeStatus.distribution} sẵn sàng`
    : 'Thiếu LaTeX runtime';
}

projectMenuButton.addEventListener('click', async () => {
  const opening = projectMenu.hidden;
  projectMenu.hidden = !opening;
  projectMenuButton.setAttribute('aria-expanded', String(opening));
  if (opening) await renderProjects();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.project-switcher')) closeProjectMenu();
});
document.querySelector('#new-project').addEventListener('click', () => {
  closeProjectMenu();
  errorBox.textContent = '';
  nameInput.value = '';
  newDialog.showModal();
  setTimeout(() => nameInput.focus(), 0);
});
document.querySelector('#create-confirm').addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    const name = nameInput.value.trim();
    if (!name) throw new Error('Hãy nhập tên project.');
    await api.createProject(name);
    newDialog.close();
  } catch (error) { errorBox.textContent = error.message; }
});
document.querySelector('#open-project').addEventListener('click', async () => {
  closeProjectMenu();
  try { await api.chooseProject(); } catch (error) { window.alert(error.message); }
});
document.querySelector('#runtime-details').addEventListener('click', () => {
  if (!runtimeStatus) return;
  const content = document.querySelector('#runtime-content');
  content.replaceChildren();
  for (const tool of runtimeStatus.tools) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    const name = document.createElement('strong');
    name.textContent = tool.name;
    const value = document.createElement('span');
    value.textContent = tool.available ? tool.path : 'Không tìm thấy';
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
  runtimeDialog.showModal();
});

api.onStateChanged(renderState);
Promise.all([api.getState(), inspectRuntime()]).then(([initialState]) => renderState(initialState));
