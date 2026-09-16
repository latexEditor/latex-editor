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
