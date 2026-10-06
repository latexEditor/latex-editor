# Kiến trúc MVP

```text
Electron main process
├─ WorkspaceManager     project, template, recent list
├─ LatexRuntimeManager  phát hiện latexmk/pdflatex/xelatex
├─ CodeServerManager    port, start, readiness, logs, shutdown
├─ HistoryManager       Git mirror, snapshot, diff, backup/restore, bundle
├─ AuthManager          Google loopback/PKCE, OS-encrypted session
├─ CloudSyncManager     manual upload/download, account binding, conflicts
├─ IPC                  API tối thiểu cho topbar
└─ WebContentsView      code-server + LaTeX Workshop
```

Renderer của topbar chạy với `nodeIntegration: false`, `contextIsolation: true` và `sandbox: true`. Nó chỉ nhận API đã liệt kê trong preload. Trang code-server nằm trong một `WebContentsView` riêng, chiếm toàn bộ vùng dưới topbar; điều hướng bị giới hạn vào đúng local origin đã khởi tạo. Vì không có sidebar Electron nên Activity Bar và Explorer của VS Code là thanh điều hướng duy nhất.

Project người dùng nằm trong `%APPDATA%\LatexEditor\projects` theo mặc định. code-server user data và extensions cũng nằm dưới `%APPDATA%\LatexEditor`, không nằm trong source tree.

Lịch sử dùng Git mirror bên ngoài project, theo hash đường dẫn; không dùng repository của người dùng. IPC lịch sử/tài khoản chỉ chấp nhận main frame của shell và project đã biết. Khi mở dialog, editor view được ẩn để không che dialog; restore cần xác nhận native.

Desktop gọi HTTPS Worker trong `latex-editor-cloud`, không truy cập R2/D1 trực tiếp. Google OAuth dùng trình duyệt hệ thống → Worker callback → loopback `127.0.0.1` với state và PKCE → đổi mã một lần lấy token phiên. Worker xác minh tài khoản qua Google userinfo; upsert user và tạo session trong D1. Mã OAuth tạm (login state, code) tiêu thụ bằng R2 conditional write.

D1 SQLite lưu user, session, project manifest, thành viên (`project_members` với role owner/editor/viewer) và lời mời. R2 chỉ lưu Git bundle bất biến và auth state tạm. Conflict detection dùng `updated_at` trong D1 thay vì ETag R2. Kiểm tra quyền phía server cho mọi thao tác đọc/ghi project.

API team: mời qua email hoặc link, chấp nhận/thu hồi lời mời, xem/xóa thành viên. Không có tự động merge, cộng tác thời gian thực hoặc web client ở phiên bản này. Xem hướng dẫn vận hành/giới hạn tại `latex-editor-cloud/README.md`.

