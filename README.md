# LaTeX Editor

Monorepo cho hệ sinh thái LaTeX Editor.

```text
latex-editor/
├─ latex-editor-desktop/   Electron + code-server + LaTeX Workshop
├─ latex-editor-web/       ứng dụng web trong milestone sau (chưa tạo)
├─ packages/shared/        model/API dùng chung khi thực sự cần (chưa tạo)
└─ KE_HOACH_LATEX_EDITOR.md
```

Hiện tại chỉ triển khai MVP desktop. Không tạo trước code web hoặc package dùng chung khi chưa có contract backend rõ ràng.

## Chạy ứng dụng desktop

Yêu cầu Node.js 20.19.5:

```powershell
nvm use 20.19.5
nvm reshim
npm install
npm run setup:desktop
npm start
```

Các lệnh `npm start`, `npm test` và `npm run check` ở root được chuyển tiếp vào workspace `latex-editor-desktop`.

Xem hướng dẫn chi tiết tại [latex-editor-desktop/README.md](latex-editor-desktop/README.md).
