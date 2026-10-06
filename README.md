# LaTeX Editor

Monorepo cho hệ sinh thái LaTeX Editor.

```text
latex-editor/
├─ latex-editor-desktop/   Electron + code-server + LaTeX Workshop
├─ latex-editor-cloud/     Cloudflare Worker: Google OAuth + R2 Git bundles
├─ latex-editor-web/       ứng dụng web trong milestone sau (chưa tạo)
├─ packages/shared/        model/API dùng chung khi thực sự cần (chưa tạo)
└─ KE_HOACH_LATEX_EDITOR.md
```

Desktop đã có lịch sử phiên bản local và giao diện tài khoản/đồng bộ cloud. Backend Google OAuth + R2 được triển khai riêng; chưa có web app, chia sẻ hoặc cộng tác thời gian thực. Khi chưa cấu hình backend, editor và lịch sử local vẫn hoạt động.

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

## Tài khoản và lưu lịch sử trên R2

Desktop mặc định kết nối Worker đã deploy của ứng dụng; `LATEX_EDITOR_API_URL` chỉ cần khi muốn ghi đè sang backend khác. Xem [hướng dẫn backend](latex-editor-cloud/README.md) để tự triển khai Worker, R2 bucket và Google OAuth client. Chỉ backend giữ Google client secret. Repository không chứa khóa dịch vụ và việc chạy test không triển khai tài nguyên cloud.

`npm test` kiểm tra desktop và luồng cloud với R2/Google giả lập. Chạy thêm `npm --prefix latex-editor-cloud test` và `npm run test:ui --workspace latex-editor-desktop` để kiểm tra API và giao diện Electron. Các test này không thay thế kiểm thử trên tài khoản Google/R2 thật sau khi deploy.
