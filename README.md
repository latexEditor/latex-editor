# LaTeX Editor

Monorepo cho hệ sinh thái LaTeX Editor — ứng dụng soạn thảo LaTeX local-first, tích hợp VS Code (qua code-server), biên dịch và xem PDF với LaTeX Workshop, lịch sử Git-like, đồng bộ Cloudflare R2/D1 và cộng tác thời gian thực bằng Durable Objects + Yjs.

```text
latex-editor/
├─ latex-editor-desktop/   Electron + code-server + LaTeX Workshop
├─ latex-editor-cloud/     Cloudflare Worker: Google OAuth + D1 + R2 + Durable Objects
├─ latex-editor-web/       ứng dụng web trong milestone sau (chưa tạo)
├─ packages/shared/        model/API dùng chung khi thực sự cần (chưa tạo)
└─ KE_HOACH_LATEX_EDITOR.md
```

## Hiện trạng tính năng

- **Desktop & Biên dịch**: Topbar tối giản, tab đa project, nhận diện MiKTeX/TeX Live, tự động chọn XeLaTeX cho fontspec/Unicode tiếng Việt, tự động mở PDF sau khi build, hỗ trợ SyncTeX hai chiều.
- **Thư viện mẫu**: 7 template tích hợp có ảnh PDF thật (Bài báo, Báo cáo, Slide XeLaTeX, CV tiếng Việt...), nhập ZIP an toàn và lưu template cá nhân.
- **Lịch sử Git-like**: Snapshot độc lập không can thiệp `.git` người dùng, xem diff, safety backup trước khi restore, xuất Git bundle v2.
- **Tài khoản & Cloud**: Đăng nhập Google PKCE, token mã hóa safeStorage, D1 SQLite lưu người dùng và metadata, R2 lưu bundle bất biến, tải bản sao, phát hiện xung đột.
- **Chia sẻ & Phân quyền**: Phân quyền owner/editor/viewer qua D1, mời bằng email hoặc link bí mật (`id:token`), thu hồi lời mời và xóa thành viên.
- **Cộng tác thời gian thực**: Durable Objects room theo project, đồng bộ Yjs tức thời cho file `.tex/.bib/.sty/.cls/.md`, presence/cursor/selection, hàng đợi thao tác file (create/delete/rename) bền vững với tombstone & operation ID, reset draft an toàn khi restore lịch sử.

## Chạy ứng dụng desktop

Yêu cầu Node.js **20.19.5**:

```powershell
nvm use 20.19.5
nvm reshim
npm install
npm run setup:desktop
npm start
```

Các lệnh `npm start`, `npm test` và `npm run check` ở root được chuyển tiếp vào workspace `latex-editor-desktop`.

Xem hướng dẫn chi tiết tại [latex-editor-desktop/README.md](latex-editor-desktop/README.md), [Kiến trúc hệ thống](latex-editor-desktop/docs/architecture.md) và [Lộ trình phát triển](latex-editor-desktop/docs/roadmap.md).

## Kiểm thử tự động

Bộ test tự động toàn diện bao gồm:
- **Desktop (74/74 pass)**: `npm test` kiểm tra workspace, template, compiler detection, Git history, safeStorage auth, cloud sync, collaboration queue.
- **Worker (28/28 pass)**: `npm --prefix latex-editor-cloud test` kiểm tra OAuth PKCE, phân quyền D1, giới hạn R2, Durable Objects WebSocket room, Yjs convergence, presence và snapshot reset.
- **Giao diện Electron UI**: `npm run test:ui --workspace latex-editor-desktop` kiểm tra shell UI, dialog, preload bridge và IPC handler thật.

## Tài khoản và triển khai Cloud

Desktop mặc định kết nối Worker đã deploy tại `https://latex-editor-cloud.emsidt.workers.dev`; cấu hình `LATEX_EDITOR_API_URL` khi muốn trỏ sang backend khác. Xem [hướng dẫn backend](latex-editor-cloud/README.md) để tự triển khai Worker, R2 bucket, D1 database và Google OAuth client.

