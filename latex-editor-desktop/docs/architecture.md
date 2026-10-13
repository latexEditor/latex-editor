# Kiến trúc hệ thống

## 1. Tổng quan các thành phần

```text
Electron main process
├─ WorkspaceManager          Quản lý project, tab làm việc, recent list, cấu hình compiler
├─ LatexRuntimeManager       Phát hiện MiKTeX/TeX Live, latexmk, pdflatex, xelatex, SyncTeX
├─ LatexWorkshopIntegration  Cấu hình recipe, auto-open PDF, inverse SyncTeX hai chiều
├─ CodeServerManager         Quản lý tiến trình code-server, port động, readiness, shutdown
├─ HistoryManager            Git mirror riêng biệt, snapshot, diff, backup an toàn, Git bundle
├─ PersonalTemplateManager   Template cá nhân, import ZIP an toàn, kiểm tra bảo mật
├─ AuthManager               Google OAuth loopback + PKCE, session mã hóa OS (safeStorage)
├─ CloudSyncManager          Đồng bộ D1 + R2, snapshot bundle, tải bản sao, phát hiện xung đột
├─ CollaborationManager      Kết nối phòng Durable Objects qua WebSocket, đồng bộ Yjs,
│                            hàng đợi thao tác file (create/delete/rename) với tombstone,
│                            exponential backoff reconnect, reset draft khi restore snapshot
├─ CollaborationBridge       Cầu nối giữa extension editor trong code-server và CollaborationManager
├─ PresenceWindowManager     Giao diện dropdown hiển thị thành viên online và presence
├─ IPC & featureIpc          Kênh giao tiếp hai chiều bảo mật giữa main và renderer
└─ WebContentsView           Nhúng code-server + LaTeX Workshop (chặn điều hướng ngoài origin)
```

## 2. Bảo mật và cách ly tiến trình

- **Renderer (Topbar)**: Chạy với `nodeIntegration: false`, `contextIsolation: true` và `sandbox: true`. Chỉ tương tác với main process qua API được định nghĩa nghiêm ngặt trong `preload.js`.
- **Vùng soạn thảo (Editor)**: Trang `code-server` nằm trong một `WebContentsView` riêng biệt, chiếm toàn bộ diện tích bên dưới topbar. Mọi hành vi điều hướng đều bị giới hạn nghiêm ngặt trong đúng origin local của `code-server`. Không có sidebar Electron thừa, toàn bộ thao tác file do Explorer của VS Code đảm nhiệm.
- **Thư mục dữ liệu**: Project người dùng mặc định nằm tại `%APPDATA%\LatexEditor\projects`. Toàn bộ user data, extension và runtime của code-server được đặt cô lập dưới `%APPDATA%\LatexEditor`, hoàn toàn tách biệt khỏi mã nguồn ứng dụng.

## 3. Lịch sử phiên bản (Git-like History)

- **Cô lập repository**: Hệ thống sử dụng Git mirror riêng biệt tại `%APPDATA%\LatexEditor\history`, băm theo đường dẫn project, hoàn toàn không can thiệp hay sửa đổi `.git` sẵn có của người dùng.
- **Đóng gói Git Bundle**: Toàn bộ lịch sử được xuất ra dưới dạng Git bundle chuẩn để lưu trữ bất biến lên Cloudflare R2 (`bundles/:projectId/:uuid.bundle`).
- **Bảo toàn dữ liệu**: Thao tác khôi phục phiên bản luôn tạo bản lưu bảo vệ (safety snapshot) trước khi ghi đè file trên đĩa.
- **Giới hạn an toàn**: Snapshot giới hạn 50 MiB và 5.000 file, tự động loại trừ các file rác sinh ra trong quá trình biên dịch LaTeX, file `.env*`, khóa riêng (`.pem`, `.key`, `.p12`) và thư mục phụ trợ.

## 4. Xác thực và Đồng bộ Cloud

- **Backend Cloudflare Worker**: Desktop chỉ giao tiếp qua HTTPS API của Worker (`latex-editor-cloud`), không bao giờ cấp quyền truy cập trực tiếp vào R2 hay D1 từ client.
- **Google OAuth**: Sử dụng trình duyệt mặc định của hệ thống với flow PKCE và mã dùng một lần (one-time code) gửi về loopback `127.0.0.1`. Token phiên được mã hóa an toàn bằng Electron `safeStorage`. Token không bao giờ được gửi xuống renderer.
- **Cơ sở dữ liệu D1 SQLite**: Lưu trữ thông tin `users`, `sessions`, `projects`, phân quyền `project_members` (`owner`, `editor`, `viewer`) và `invitations`. Phát hiện xung đột dựa trên `updated_at` trong D1.
- **Lưu trữ R2**: Lưu trữ Git bundle bất biến và auth state tạm thời. Kiểm tra quyền hạn phía server cho mọi thao tác đọc/ghi.
- **Quản lý chia sẻ & nhóm**: Mời qua email (với email template HTML) hoặc mã link bí mật (`id:token`), chấp nhận/thu hồi lời mời, xem danh sách và xóa thành viên (chặn xóa owner cuối cùng).

## 5. Cộng tác thời gian thực (Real-time Collaboration)

- **Durable Objects Room**: Mỗi project có một phòng điều phối riêng biệt quản lý qua Cloudflare Durable Objects và WebSocket, xác thực token thành viên trước khi cho phép kết nối.
- **Đồng bộ nội dung bằng Yjs**: Hợp nhất thay đổi tức thời cho các định dạng văn bản `.tex`, `.bib`, `.sty`, `.cls`, `.md`. Phân quyền editor có thể sửa đổi, viewer chỉ có quyền đọc và bị chặn ghi cả ở client lẫn server.
- **Presence, Cursor & Selection**: Hiển thị avatar, tên người dùng, vị trí con trỏ và vùng bôi đen (selection) theo thời gian thực của từng thành viên trong cùng file.
- **Đồng bộ thao tác file**: Tạo, xóa và đổi tên file được đồng bộ qua manifest có revision và tombstone. Client duy trì hàng đợi thao tác bền vững trong workspace state, tự động gửi lại sau khi khởi động và chỉ xóa khi Worker phản hồi ACK kèm operation ID.
- **Khôi phục lịch sử khi đang cộng tác**: Khi thực hiện khôi phục phiên bản lịch sử cũ trên project đang mở phòng cộng tác, ứng dụng yêu cầu room online và quyền editor/owner, xác nhận số người bị ảnh hưởng, thay thế nguyên tử manifest và draft Yjs, sau đó đợi Worker xác nhận đầy đủ trước khi cập nhật bundle mới. Draft cleanup được thiết kế an toàn kể cả khi Durable Object bị khởi động lại giữa chừng.

## 6. Xóa Project trên Cloud

- **Phân quyền chặt chẽ**: Chỉ `owner` của dự án mới có quyền gửi yêu cầu xóa qua `DELETE /v1/projects/:id`.
- **Dọn dẹp triệt để phía Cloud**:
  - Hủy phòng Durable Objects và đóng kết nối tất cả WebSocket client với mã trạng thái `4003 ('Project deleted')`, xóa toàn bộ persistent storage của phòng.
  - Xóa toàn bộ Git bundle liên quan trong Cloudflare R2 (`bundles/:projectId/*`).
  - Xóa bản ghi trong Cloudflare D1 (tự động kích hoạt `ON DELETE CASCADE` dọn sạch `project_members` và `invitations`).
- **An toàn phía Desktop**:
  - Yêu cầu xác nhận qua hộp thoại hệ thống (`dialog.showMessageBox`).
  - Ngắt kết nối phòng cộng tác cục bộ ngay lập tức và dọn dẹp file metadata cloud `.json`.
  - Giữ nguyên toàn bộ mã nguồn và lịch sử phiên bản trên ổ đĩa máy tính người dùng.

## 7. Đóng gói và Phân phối Ứng dụng

- **Electron Builder & NSIS/Portable**: Cấu hình đóng gói installer Windows x64 (`dist/LaTeX Editor Setup 0.5.0.exe`), bản portable không cần cài đặt (`dist/LaTeX Editor-0.5.0-portable.exe`) và thư mục unpacked (`dist/win-unpacked`).
- **Đóng gói Runtime & Tiện ích mở rộng**:
  - Node.js 20.19.5 x64 và code-server portable được đưa vào `resources/runtime/`.
  - Extension `LaTeX Workshop` (10.7.4 universal) được nhúng sẵn trong `resources/extensions/` và tự động cài đặt vào `%APPDATA%\LatexEditor\extensions` khi khởi động lần đầu, hoàn toàn không cần tải từ mạng.
- **Icon thương hiệu**: Bộ icon đa kích thước (`icon.ico` từ 16x16 đến 256x256 và `icon.png` 512x512) áp dụng cho cửa sổ ứng dụng và tệp thực thi.

## 8. Đồng bộ Template Cá nhân lên Cloud (Personal Template Cloud Sync)

- **Cơ chế đóng gói ZIP thuần Node.js (`PersonalTemplateManager.js`)**:
  - Tự sinh file ZIP chuẩn PKZIP v2.0 bằng `node:zlib` (`crc32` và `deflateRawSync`), không phụ thuộc thêm thư viện bên ngoài.
  - Tương thích 100% với trình giải nén `yauzl` hiện có.
  - Hỗ trợ xuất template thành buffer ZIP (`exportZipBuffer`) và nạp ngược lại thư mục template (`importFromBuffer`).
- **Cloud Storage & Database (R2 & D1)**:
  - Bảng D1 `user_templates` lưu thông tin định danh, metadata (tên, mô tả, danh mục, file chính, phiên bản, thời gian cập nhật).
  - Khóa R2 `templates/:userId/:templateId.zip` lưu trữ payload ZIP nén.
  - Cách ly dữ liệu hoàn toàn theo `user_id` với cascade delete khi tài khoản bị thu hồi hoặc template bị xóa.
- **Quy trình đồng bộ trên Desktop (`CloudSyncManager.js`)**:
  - `listCloudTemplates()`: Liệt kê danh sách template đã lưu trên cloud của tài khoản.
  - `uploadTemplate(templateId)`: Đóng gói template nội bộ và đẩy lên Cloudflare R2 / D1.
  - `downloadTemplate(templateId)`: Tải ZIP từ R2 và bung vào thư mục template cục bộ `%APPDATA%\LatexEditor\templates\personal-<id>`.
  - `deleteCloudTemplate(templateId)`: Xóa template khỏi Cloudflare R2 và D1.
  - `syncAllTemplates()`: Đồng bộ hai chiều thông minh: tự động tải lên các template chỉ có ở local và tải về các template chỉ có trên cloud.
- **Tích hợp giao diện người dùng**:
  - Hộp thoại Tạo dự án mới (`#new-dialog`): Nút "☁ Đồng bộ Template Cloud" trên tiêu đề danh mục cá nhân, cùng các nút thao tác nhanh "Tải lên Cloud" và "Xóa" trên từng thẻ template.
  - Hộp thoại Tài khoản (`#account-dialog`): Thẻ "Template Cá nhân trên Cloud" hiển thị danh sách template lưu trữ từ xa, hỗ trợ tải về máy, xóa khỏi cloud và nút "Đồng bộ tất cả".



