# LaTeX Editor Desktop

Ứng dụng Electron local-first để sửa, biên dịch và xem tài liệu LaTeX trong giao diện VS Code nhúng qua code-server.

## Yêu cầu

Windows 10/11 x64, Git for Windows, Node.js **20.19.5**, cùng MiKTeX hoặc TeX Live có binary trong `PATH`.

## Cài đặt và chạy

Từ thư mục gốc monorepo:

```powershell
npm install
npm run setup:desktop
npm start
```

Hoặc chạy trực tiếp trong thư mục này:

```powershell
npm run setup:code-server
npm run setup:latex-workshop
npm run check:latex
npm start
```

Mặc định dữ liệu nằm trong `%APPDATA%\LatexEditor`. Google login, Git/R2 sync và collaboration chưa thuộc MVP desktop.

Xem thêm [docs/development.md](docs/development.md) và [docs/architecture.md](docs/architecture.md).

## Project và mẫu tài liệu

- **Project mới**: chọn Bài báo, Báo cáo nhiều chương, Slide Beamer 16:9 hoặc Tài liệu tối giản. Nội dung mẫu dùng tiếng Anh, biên dịch bằng pdfLaTeX; hỗ trợ tiếng Việt trong tài liệu cần cấu hình font/compiler phù hợp.
- **Gần đây**: tìm theo tên/đường dẫn và mở lại tối đa 12 project gần nhất, kể cả sau khi khởi động lại app. Trang trống hiển thị 5 project gần nhất để mở nhanh.
- **Vị trí** mở thư mục project trong File Explorer. **Mở nơi lưu project** mở thư mục gốc, mặc định là `%APPDATA%\LatexEditor\projects` (có thể thay đổi bằng `LATEX_EDITOR_PROJECTS_DIR`). Hộp thoại luôn hiển thị đường dẫn thực tế đang dùng.
- **Bỏ** chỉ gỡ project khỏi lịch sử; file và tab đang mở vẫn được giữ lại. Thư mục bị di chuyển/xóa được đánh dấu để bạn có thể bỏ khỏi danh sách và mở lại vị trí mới.

Mẫu slide cần gói `beamer` và các phụ thuộc trong MiKTeX/TeX Live. Với mẫu báo cáo, nếu dùng recipe pdfLaTeX một lượt, build hai lần để cập nhật mục lục.

Kiểm tra logic bằng `npm test`. Chạy `npm run test:ui --workspace latex-editor-desktop` từ root để kiểm tra giao diện cùng preload/IPC thật trong một cửa sổ Electron ẩn, dùng project tạm riêng và không khởi động code-server.
