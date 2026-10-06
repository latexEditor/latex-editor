const PROJECT_TEMPLATES = [
  { id: 'basic-article', name: 'Bài báo', category: 'Bài viết', language: 'Tiếng Anh', engine: 'pdflatex', description: 'Bài viết ngắn với tóm tắt, công thức và liên kết.' },
  { id: 'report', name: 'Báo cáo', category: 'Học thuật', language: 'Tiếng Anh', engine: 'pdflatex', description: 'Trang bìa, mục lục và các chương nằm trong file riêng.' },
  { id: 'report-vi', name: 'Báo cáo tiếng Việt', category: 'Học thuật', language: 'Tiếng Việt', engine: 'xelatex', description: 'Bìa báo cáo, mục lục, công thức và các chương mẫu tiếng Việt.' },
  { id: 'thesis-vi', name: 'Luận văn tiếng Việt', category: 'Học thuật', language: 'Tiếng Việt', engine: 'xelatex', description: 'Bìa, lời cảm ơn, tóm tắt, chương nghiên cứu và tài liệu tham khảo. Mẫu chung, cần chỉnh theo quy định của trường.' },
  { id: 'cv-vi', name: 'CV tiếng Việt', category: 'Hồ sơ', language: 'Tiếng Việt', engine: 'xelatex', description: 'CV một cột với giới thiệu, học vấn, kinh nghiệm và kỹ năng; dễ thay thông tin.' },
  { id: 'presentation', name: 'Slide thuyết trình', category: 'Thuyết trình', language: 'Tiếng Anh', engine: 'pdflatex', description: 'Slide Beamer tỉ lệ 16:9, có tiêu đề và ví dụ công thức.' },
  { id: 'blank', name: 'Tài liệu tối giản', category: 'Bài viết', language: 'Tiếng Anh', engine: 'pdflatex', description: 'Một file main.tex với cấu trúc LaTeX cơ bản.' }
];

module.exports = { PROJECT_TEMPLATES };
