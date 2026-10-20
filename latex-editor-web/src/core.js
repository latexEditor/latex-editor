export const TEMPLATES = [
  {
    id: 'article',
    name: 'Bài báo khoa học',
    description: 'Bố cục bài báo với tóm tắt, mục lục và tài liệu tham khảo.',
    accent: '#d5654d',
    files: {
      'main.tex': String.raw`\documentclass[12pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T5]{fontenc}
\usepackage[vietnamese]{babel}
\usepackage{amsmath,graphicx,hyperref}
\title{Một tài liệu được viết thật chỉn chu}
\author{Nguyễn An}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Đây là phần tóm tắt. Hãy trình bày ngắn gọn câu hỏi, phương pháp và kết quả chính của bạn.
\end{abstract}

\section{Giới thiệu}
LaTeX giúp nội dung phức tạp trở nên rõ ràng. Công thức nổi tiếng
\begin{equation}
  e^{i\pi} + 1 = 0
\end{equation}
là một ví dụ về cách trình bày toán học đẹp và nhất quán.

\section{Phương pháp}
Viết nội dung của bạn ở đây. Thay đổi sẽ được tự động lưu trong trình duyệt.

\section{Kết luận}
Một kết luận tốt nhắc lại đóng góp chính và mở ra hướng nghiên cứu tiếp theo.

\end{document}`,
      'references.bib': '@article{example,\n  title={A thoughtful example},\n  author={Nguyen, An},\n  year={2026}\n}\n'
    }
  },
  {
    id: 'report', name: 'Báo cáo kỹ thuật', description: 'Chương, mục lục và cấu trúc báo cáo dài.', accent: '#396d63',
    files: { 'main.tex': String.raw`\documentclass[12pt,a4paper]{report}
\title{Báo cáo kỹ thuật}
\author{Nhóm nghiên cứu}
\begin{document}
\maketitle
\tableofcontents
\chapter{Tổng quan}
Mô tả bối cảnh và mục tiêu của dự án.
\chapter{Kết quả}
Trình bày kết quả và thảo luận tại đây.
\end{document}` }
  },
  {
    id: 'thesis', name: 'Luận văn', description: 'Khung luận văn với chương và phụ lục.', accent: '#5967a6',
    files: { 'main.tex': String.raw`\documentclass[12pt,a4paper,oneside]{book}
\title{Tên đề tài luận văn}
\author{Tên học viên}
\begin{document}
\frontmatter\maketitle\tableofcontents
\mainmatter
\chapter{Mở đầu}
Đặt vấn đề nghiên cứu tại đây.
\chapter{Cơ sở lý thuyết}
Tổng hợp các công trình liên quan.
\backmatter
\end{document}` }
  },
  {
    id: 'letter', name: 'Thư chuyên nghiệp', description: 'Một lá thư tối giản, trang trọng.', accent: '#9a7041',
    files: { 'main.tex': String.raw`\documentclass{letter}
\signature{Nguyễn An}
\address{Thành phố Hồ Chí Minh, Việt Nam}
\begin{document}
\begin{letter}{Kính gửi Quý đối tác,}
\opening{Xin chào,}
Nội dung thư của bạn bắt đầu tại đây.
\closing{Trân trọng,}
\end{letter}
\end{document}` }
  }
];

export function createProject(template = TEMPLATES[0], name = 'Tài liệu chưa đặt tên') {
  return {
    id: globalThis.crypto?.randomUUID?.() || `project-${Date.now()}`,
    name: name.trim() || 'Tài liệu chưa đặt tên',
    templateId: template.id,
    activeFile: Object.keys(template.files)[0],
    files: structuredClone(template.files),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function extractDocumentMeta(source = '') {
  const find = (pattern, fallback) => source.match(pattern)?.[1]?.trim() || fallback;
  const sections = [...source.matchAll(/\\(?:chapter|section)\*?\{([^}]+)\}/g)].map((match) => match[1]);
  const abstract = find(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/, '');
  const body = source
    .replace(/%.*$/gm, '')
    .replace(/\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{[^}]*\}/g, '')
    .replace(/\\(?:title|author|date)\{[^}]*\}/g, '')
    .replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}|\\maketitle|\\tableofcontents/g, '')
    .replace(/\\(?:chapter|section)\*?\{[^}]+\}/g, '')
    .replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: find(/\\title\{([^}]+)\}/, 'Tài liệu chưa đặt tên'),
    author: find(/\\author\{([^}]+)\}/, 'Tác giả'),
    sections,
    abstract,
    body
  };
}

export function validateProject(project) {
  return Boolean(project && typeof project.id === 'string' && typeof project.name === 'string' && project.files && typeof project.files === 'object' && Object.keys(project.files).length);
}
