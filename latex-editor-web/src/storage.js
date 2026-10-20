import { createProject, TEMPLATES, validateProject } from './core.js';

const KEY = 'latex-editor-web:v1';

export function loadWorkspace(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(KEY));
    const projects = Array.isArray(parsed?.projects) ? parsed.projects.filter(validateProject) : [];
    if (projects.length) return { projects, activeProjectId: projects.some((item) => item.id === parsed.activeProjectId) ? parsed.activeProjectId : projects[0].id };
  } catch {}
  const first = createProject(TEMPLATES[0], 'Bài báo đầu tiên');
  return { projects: [first], activeProjectId: first.id };
}

export function saveWorkspace(workspace, storage = localStorage) {
  storage.setItem(KEY, JSON.stringify(workspace));
}

export function exportProject(project) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${project.name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}.latex-project.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
