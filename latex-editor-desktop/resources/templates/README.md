# Mẫu tài liệu tích hợp

Các mẫu trong thư mục này được viết cho LaTeX Editor, không sao chép bộ mẫu của bên thứ ba. Các gói LaTeX và font đi kèm tuân theo giấy phép của dự án tương ứng.

- basic-article, report, presentation, blank: pdfLaTeX (hoặc latexmk với chế độ PDF).
- report-vi, thesis-vi, cv-vi: XeLaTeX, font Latin Modern Roman. Recipe chạy hai lượt để cập nhật mục lục và tham chiếu.
- Luận văn là mẫu tổng quát; cần điều chỉnh theo hướng dẫn của trường.
- Nội dung tên, email, năm và đơn vị đều là ví dụ để thay thế.

Khi thêm mẫu, đăng ký metadata trong src/main/ProjectTemplates.js và đặt main.tex trong thư mục có tên trùng với id. Project mới là bản sao độc lập của mẫu.
