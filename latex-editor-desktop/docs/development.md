# Thiết lập môi trường phát triển

## Baseline

- Windows 10/11 x64
- Git for Windows (script setup dùng Git Bash cho postinstall của code-server)
- Node.js 20.19.5 cho Electron/npm (`.nvmrc`), theo baseline đã chạy ổn định của repo tham chiếu
- Electron 43.2.0
- code-server 4.93.1 chạy bằng Node 20 riêng trong `runtime/`
- LaTeX Workshop 10.4.0 (tương thích với VS Code 1.93 trong code-server đã pin)
- MiKTeX hoặc TeX Live có `latexmk`/`pdflatex` trong PATH

## Kiểm tra nhanh

```powershell
node --version
npm install
npm run setup:code-server
npm run setup:latex-workshop
npm run check:latex
npm test
npm start
```

`check:latex` trả exit code 2 nếu máy chưa có compiler. Đây không phải lỗi JavaScript; cài MiKTeX/TeX Live rồi mở terminal mới.

code-server được cô lập trên Node 20.19.5 bởi script setup để không phụ thuộc vào cấu hình Node toàn hệ thống.

## Biến môi trường

| Biến | Ý nghĩa |
| --- | --- |
| `LATEX_EDITOR_API_URL` | URL backend Worker (mặc định trỏ production `https://latex-editor-cloud.emsidt.workers.dev`) |
| `LATEX_EDITOR_DATA_DIR` | toàn bộ dữ liệu local của app (`%APPDATA%\LatexEditor`) |
| `LATEX_EDITOR_PROJECTS_DIR` | thư mục lưu project mặc định |
| `CODE_SERVER_BIN` | đường dẫn binary code-server tùy chỉnh |
| `CODE_SERVER_PORT` | cổng ưu tiên cho code-server |
| `CODE_SERVER_READY_TIMEOUT_MS` | thời gian chờ tối đa cho code-server sẵn sàng (ms) |

## Kiểm thử tự động

- `npm test`: Chạy 74 unit và integration test cho desktop (workspace, template, compiler detection, Git history, safeStorage auth, cloud sync, collaboration queue).
- `npm run test:ui`: Khởi động Electron ẩn và kiểm tra tương tác thực tế giữa shell UI, preload bridge và IPC handler.
- `npm run check`: Kiểm tra cú pháp toàn bộ file mã nguồn.

