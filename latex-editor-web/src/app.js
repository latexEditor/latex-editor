import { createProject, extractDocumentMeta, TEMPLATES } from './core.js';
import { exportProject, loadWorkspace, saveWorkspace } from './storage.js';
import { LatexEditorApi } from './api.js';

const $ = (selector) => document.querySelector(selector);
const elements = {
  editor: $('#editor'), lineNumbers: $('#line-numbers'), projectName: $('#project-name'), projectSelect: $('#project-select'),
  fileTree: $('#file-tree'), tabs: $('#tabs'), outline: $('#outline'), saveState: $('#save-state'), cursor: $('#cursor-position'),
  console: $('#console'), consoleOutput: $('#console-output'), paper: $('#paper'), previewTitle: $('#preview-title'),
  previewAuthor: $('#preview-author'), previewContent: $('#preview-content'), toast: $('#toast'), sidebar: $('#sidebar')
};

let workspace = loadWorkspace();
let zoom = 0.82;
let selectedTemplateId = TEMPLATES[0].id;
let saveTimer;
let previewTimer;
let api = new LatexEditorApi(localStorage.getItem('latex-editor-web:api-url') || '');

const activeProject = () => workspace.projects.find((project) => project.id === workspace.activeProjectId) || workspace.projects[0];
const activeSource = () => activeProject().files[activeProject().activeFile] || '';
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function persist() {
  elements.saveState.classList.add('saving');
  elements.saveState.innerHTML = '<i></i> Đang lưu…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveWorkspace(workspace);
    elements.saveState.classList.remove('saving');
    elements.saveState.innerHTML = '<i></i> Đã lưu cục bộ';
  }, 280);
}

function renderProjects() {
  elements.projectSelect.innerHTML = workspace.projects.map((project) => `<option value="${project.id}" ${project.id === workspace.activeProjectId ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
  elements.projectName.value = activeProject().name;
}

function fileIcon(name) {
  if (name.endsWith('.tex')) return '<span class="tex-icon">T</span>';
  if (name.endsWith('.bib')) return '<span class="bib-icon">B</span>';
  return '<span class="file-icon">·</span>';
}

function renderFiles() {
  const project = activeProject();
  elements.fileTree.innerHTML = Object.keys(project.files).map((name) => `<button class="file-row ${name === project.activeFile ? 'active' : ''}" data-file="${escapeHtml(name)}">${fileIcon(name)}<span>${escapeHtml(name)}</span><small>${name === project.activeFile ? '●' : ''}</small></button>`).join('');
  elements.tabs.innerHTML = `<button class="editor-tab active">${fileIcon(project.activeFile)}<span>${escapeHtml(project.activeFile)}</span><i></i></button>`;
}

function renderEditor() {
  elements.editor.value = activeSource();
  updateLineNumbers();
  updateCursor();
  renderPreview();
}

function renderOutline(meta = extractDocumentMeta(activeSource())) {
  elements.outline.innerHTML = meta.sections.length
    ? meta.sections.map((section, index) => `<button><span>${index + 1}</span>${escapeHtml(section)}</button>`).join('')
    : '<p>Thêm \\section{…} để tạo dàn ý.</p>';
}

function renderPreview() {
  const meta = extractDocumentMeta(activeSource());
  elements.previewTitle.textContent = meta.title;
  elements.previewAuthor.textContent = meta.author;
  const sections = meta.sections.length ? meta.sections : ['Nội dung'];
  const paragraphs = meta.body.split(/\n\s*\n/).filter(Boolean);
  elements.previewContent.innerHTML = [
    meta.abstract ? `<section class="paper-abstract"><strong>Tóm tắt</strong><p>${escapeHtml(meta.abstract)}</p></section>` : '',
    ...sections.map((section, index) => `<section><h2>${index + 1}. ${escapeHtml(section)}</h2><p>${escapeHtml(paragraphs[index] || paragraphs[0] || 'Bắt đầu viết nội dung trong trình soạn thảo.')}</p></section>`)
  ].join('');
  renderOutline(meta);
}

function updateLineNumbers() {
  const count = Math.max(1, elements.editor.value.split('\n').length);
  elements.lineNumbers.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
  elements.lineNumbers.scrollTop = elements.editor.scrollTop;
}

function updateCursor() {
  const before = elements.editor.value.slice(0, elements.editor.selectionStart).split('\n');
  elements.cursor.textContent = `Ln ${before.length}, Col ${before.at(-1).length + 1}`;
}

function renderAll() {
  renderProjects();
  renderFiles();
  renderEditor();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  setTimeout(() => elements.toast.classList.remove('show'), 2400);
}

elements.editor.addEventListener('input', () => {
  const project = activeProject();
  project.files[project.activeFile] = elements.editor.value;
  project.updatedAt = Date.now();
  updateLineNumbers();
  updateCursor();
  persist();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 180);
});
elements.editor.addEventListener('scroll', () => { elements.lineNumbers.scrollTop = elements.editor.scrollTop; });
elements.editor.addEventListener('keyup', updateCursor);
elements.editor.addEventListener('click', updateCursor);
elements.editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const start = elements.editor.selectionStart;
    elements.editor.setRangeText('  ', start, elements.editor.selectionEnd, 'end');
    elements.editor.dispatchEvent(new Event('input'));
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); persist(); showToast('Đã lưu project cục bộ'); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('#compile-button').click(); }
});

elements.fileTree.addEventListener('click', (event) => {
  const row = event.target.closest('[data-file]');
  if (!row) return;
  activeProject().activeFile = row.dataset.file;
  renderFiles();
  renderEditor();
  elements.editor.focus();
  if (window.innerWidth < 800) elements.sidebar.classList.remove('open');
});

elements.projectSelect.addEventListener('change', () => { workspace.activeProjectId = elements.projectSelect.value; persist(); renderAll(); });
elements.projectName.addEventListener('input', () => { activeProject().name = elements.projectName.value || 'Tài liệu chưa đặt tên'; activeProject().updatedAt = Date.now(); renderProjects(); persist(); });

$('#new-file-button').addEventListener('click', () => {
  const raw = prompt('Tên tệp mới (ví dụ: methods.tex)');
  if (!raw) return;
  const name = raw.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!name || activeProject().files[name] !== undefined) return showToast('Tên tệp không hợp lệ hoặc đã tồn tại');
  activeProject().files[name] = name.endsWith('.bib') ? '@article{key,\n  title={Title}\n}\n' : '% Tệp mới\n';
  activeProject().activeFile = name;
  persist(); renderFiles(); renderEditor();
});

const projectDialog = $('#project-dialog');
$('#new-project-button').addEventListener('click', () => projectDialog.showModal());
$('#template-grid').innerHTML = TEMPLATES.map((template, index) => `<button type="button" class="template-card ${index === 0 ? 'selected' : ''}" data-template="${template.id}" style="--accent:${template.accent}"><span>${template.name.slice(0, 1)}</span><strong>${template.name}</strong><small>${template.description}</small></button>`).join('');
$('#template-grid').addEventListener('click', (event) => {
  const card = event.target.closest('[data-template]'); if (!card) return;
  selectedTemplateId = card.dataset.template;
  document.querySelectorAll('.template-card').forEach((item) => item.classList.toggle('selected', item === card));
});
$('#confirm-project').addEventListener('click', (event) => {
  event.preventDefault();
  const template = TEMPLATES.find((item) => item.id === selectedTemplateId) || TEMPLATES[0];
  const project = createProject(template, $('#new-project-name').value);
  workspace.projects.unshift(project); workspace.activeProjectId = project.id;
  saveWorkspace(workspace); projectDialog.close(); renderAll(); showToast('Project mới đã sẵn sàng');
});

$('#compile-button').addEventListener('click', async () => {
  const button = $('#compile-button'); button.classList.add('working'); button.innerHTML = '<span>◌</span> Đang biên dịch';
  elements.console.classList.add('open');
  elements.consoleOutput.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] Đang kiểm tra ${activeProject().activeFile}…\n`;
  try {
    const blob = await api.compile({ files: activeProject().files, entry: activeProject().activeFile });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    elements.consoleOutput.textContent += '✓ Biên dịch thành công. PDF đã được mở trong tab mới.';
  } catch (error) {
    renderPreview();
    elements.consoleOutput.textContent += `✓ Cú pháp đã được cập nhật vào bản xem nhanh cục bộ.\nℹ ${error.message}`;
  } finally {
    button.classList.remove('working'); button.innerHTML = '<span aria-hidden="true">▶</span> Biên dịch';
  }
});

$('#toggle-console').addEventListener('click', () => elements.console.classList.toggle('open'));
$('#close-console').addEventListener('click', () => elements.console.classList.remove('open'));
$('#download-button').addEventListener('click', () => { exportProject(activeProject()); showToast('Đã xuất project'); });
$('#mobile-menu').addEventListener('click', () => elements.sidebar.classList.toggle('open'));

function setZoom(next) { zoom = Math.min(1.2, Math.max(0.55, next)); elements.paper.style.transform = `scale(${zoom})`; $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`; }
$('#zoom-in').addEventListener('click', () => setZoom(zoom + 0.08));
$('#zoom-out').addEventListener('click', () => setZoom(zoom - 0.08));
$('#open-preview').addEventListener('click', () => $('#preview-canvas').requestFullscreen?.());

$('#theme-toggle').addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('latex-editor-web:theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
});
if (localStorage.getItem('latex-editor-web:theme') === 'dark') document.documentElement.classList.add('dark');

const settingsDialog = $('#settings-dialog');
$('#settings-button').addEventListener('click', () => { $('#api-url').value = api.baseUrl; settingsDialog.showModal(); });
$('#cloud-status').addEventListener('click', () => { $('#api-url').value = api.baseUrl; settingsDialog.showModal(); });
$('#save-settings').addEventListener('click', (event) => {
  event.preventDefault();
  const url = $('#api-url').value.trim(); localStorage.setItem('latex-editor-web:api-url', url); api = new LatexEditorApi(url);
  settingsDialog.close(); showToast(url ? 'Đã lưu kết nối backend' : 'Đã chuyển về chế độ local'); updateCloudStatus();
});
async function updateCloudStatus() {
  const status = $('#cloud-status');
  try {
    const health = await api.health();
    status.innerHTML = health.local ? '<i></i><span><strong>Local-first</strong><small>Dữ liệu ở trình duyệt này</small></span>' : '<i class="online"></i><span><strong>Cloud sẵn sàng</strong><small>Đã kết nối backend</small></span>';
  } catch { status.innerHTML = '<i class="error"></i><span><strong>Mất kết nối</strong><small>Đang làm việc cục bộ</small></span>'; }
}

$('#share-button').addEventListener('click', () => showToast('Cộng tác cloud sẽ khả dụng sau khi đăng nhập web'));
$('#account-button').addEventListener('click', () => showToast('Chế độ khách · dữ liệu được lưu cục bộ'));
document.querySelectorAll('.activity[data-panel]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.activity[data-panel]').forEach((item) => item.classList.toggle('active', item === button));
  if (button.dataset.panel !== 'files') showToast(`${button.title}: đang chuẩn bị cho bản cloud`);
}));

setZoom(zoom);
renderAll();
updateCloudStatus();
