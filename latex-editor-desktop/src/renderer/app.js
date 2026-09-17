const api = window.latexEditor;
const newDialog = document.querySelector('#new-dialog');
const runtimeDialog = document.querySelector('#runtime-dialog');
const nameInput = document.querySelector('#new-project-name');
const errorBox = document.querySelector('#dialog-error');
let currentState = { phase: 'starting', project: null };
let runtimeStatus;

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
  await api.hideEditor();
  newDialog.showModal();
  setTimeout(() => nameInput.focus(), 0);
});
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
document.querySelector('#create-confirm').addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    const name = nameInput.value.trim();
    if (!name) throw new Error('Hãy nhập tên project.');
    await api.createProject(name);
    newDialog.close();
  } catch (error) { errorBox.textContent = error.message; }
});
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
Promise.all([api.getState(), inspectRuntime()]).then(([initialState]) => renderState(initialState));
