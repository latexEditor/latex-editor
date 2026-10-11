# Lộ trình phát triển hệ thống LaTeX Editor

## Đợt 1 — Thư viện mẫu (Hoàn thành)

- [x] Phân loại, tìm kiếm không dấu, thông tin ngôn ngữ và compiler.
- [x] Báo cáo tiếng Việt, luận văn tiếng Việt và CV; XeLaTeX cho Unicode.
- [x] Giữ cấu hình compiler khi mở lại project.
- [x] Ảnh xem trước trang đầu được render từ PDF thật của từng mẫu.
- [x] Nhập mẫu từ ZIP và lưu project thành mẫu cá nhân; kiểm tra đường dẫn, dung lượng, symlink và loại dữ liệu sinh ra/bí mật.

## Đợt 2 — Project dùng chung và Phân quyền (Hoàn thành)

- [x] D1 SQLite lưu user, session, project manifest, thành viên và lời mời; R2 lưu Git bundle và auth state tạm.
- [x] Bảng `project_members` với quyền owner/editor/viewer; kiểm tra quyền phía server cho mọi thao tác.
- [x] API mời qua email, chấp nhận lời mời, thu hồi lời mời, xóa thành viên.
- [x] Test tự động: cô lập project theo tài khoản, mời/chấp nhận/thu hồi, quyền viewer/editor/owner, ngăn xóa owner cuối.
- [x] Project ID dùng chung (bảng `projects` toàn cục kết hợp `project_members`, R2 bundle key dạng `bundles/:projectId/:uuid.bundle`).
- [x] Project mới yêu cầu đăng nhập, tự tạo snapshot/upload lên R2; lưu hoặc khôi phục lịch sử tự đồng bộ lại và vẫn giữ bản local khi mạng lỗi.
- [x] Mời qua link bí mật (hỗ trợ cả API backend và UI desktop tạo/sao chép/nhập mã tham gia `id:token`).
- [x] Giao diện desktop cho chia sẻ project và quản lý thành viên (hộp thoại Chia sẻ, danh sách thành viên kèm role badge, mời qua email/link, thu hồi và xóa thành viên).
- [x] Môi trường Worker & D1 thật đã được tạo và deploy trên Cloudflare (`latex-editor-db`, binding `DB`, 5 bảng).
- [x] Test Electron cho giao diện mời, chấp nhận bằng tài khoản thứ hai, danh sách thành viên, xóa thành viên và thu hồi link mời.
- [x] Worker tạo email transactional dạng text + HTML và trang hướng dẫn nhận lời mời; tự hạ cấp về thông báo trong app khi binding email chưa sẵn sàng.
- [x] Link mời dùng cặp invitation ID + token bí mật; server xác minh token trước khi thêm thành viên.

## Đợt 3 — Cộng tác thời gian thực (Hoàn thành)

- [x] Quản lý room theo project bằng Cloudflare Durable Objects + WebSocket: xác thực thành viên, presence, cursor/selection, ngắt kết nối khi thu hồi quyền, lưu draft Yjs theo file và tự hoàn tất cleanup dang dở khi room khởi động lại.
- [x] Desktop kết nối room, hiển thị người online (dropdown presence có tên và avatar), cursor/selection và extension code-server đồng bộ nội dung `.tex/.bib/.sty/.cls/.md`.
- [x] Phân quyền cộng tác: viewer bị chặn ghi ở cả client lẫn server; client tự kết nối lại với exponential backoff.
- [x] Đồng bộ tạo/xóa/đổi tên file qua manifest có revision và tombstone; hàng đợi thao tác lưu trong workspace state, gửi lại sau khi mở app và Worker khử thao tác trùng bằng operation ID. File bị xóa đưa vào Recycle Bin máy nhận.
- [x] Phân biệt draft cộng tác với snapshot lịch sử: restore yêu cầu room online và quyền ghi, xác nhận số người bị ảnh hưởng, reset nguyên tử manifest và draft Yjs rồi chờ đủ ACK trước khi upload bundle mới.
- [x] Bộ test hoàn chỉnh: kiểm thử hai editor sửa cùng vị trí rồi reconnect vẫn hội tụ; kiểm thử thu hồi quyền ngắt phiên và chặn non-member kết nối lại.

## Đợt 4 — Hoàn thiện Desktop và Đóng gói phát hành (Ưu tiên hiện tại)

- [x] **Deploy Worker HEAD**: Đã deploy bản Worker mới nhất lên Cloudflare (`Version ID: 1e1f9ec2-0033-4b79-976b-3c190537e464`); xác nhận qua `/health` (`configured: true`, `collaborationConfigured: true`).
- [ ] **Kiểm thử nghiệm thu 2 tài khoản thật**: Thử nghiệm trên môi trường production với hai tài khoản Google thật:
  - Mời và chấp nhận chia sẻ qua email & link bí mật.
  - Chỉnh sửa đồng thời, hiển thị cursor/presence và hội tụ nội dung.
  - Kiểm tra viewer bị chặn ghi, thu hồi quyền khi đang online.
  - Reconnect khi ngắt mạng và khôi phục lịch sử khi nhiều người đang mở.
- [x] **Đóng gói bộ cài Windows**:
  - Cấu hình đóng gói Electron (`electron-builder` / NSIS installer và portable `.exe`).
  - Đóng gói kèm hoặc tự động cài đặt runtime cô lập (Node 20, code-server, LaTeX Workshop extension).
  - Shortcut Start Menu, Desktop và trình gỡ cài đặt (uninstaller).
- [ ] **Nghiệm thu máy Windows sạch**:
  - Kiểm thử cài đặt từ đầu trên máy chưa có Node/npm và chưa có MiKTeX.
  - Kiểm thử đường dẫn cài đặt có dấu tiếng Việt và khoảng trắng.
  - Luồng: Cài app → cài runtime → đăng nhập → tạo project → build PDF.

## Đợt 5 — Cloud, Vận hành và Thư viện mẫu

- [ ] Quota dung lượng lưu trữ theo tài khoản và theo project.
- [ ] Garbage collection cho các Git bundle R2 cũ không còn manifest tham chiếu.
- [x] Chức năng xóa project cloud (Durable Object cleanup, R2 bundle purge, D1 cascade delete, confirmation dialog trên Desktop).
- [ ] Chức năng xóa tài khoản người dùng và thu hồi toàn bộ dữ liệu liên quan.
- [ ] Sao lưu tự động định kỳ cho R2 và D1 database.
- [ ] Refresh token / gia hạn session dài hạn an toàn.
- [ ] Load-test bundle gần giới hạn 50 MiB trên Worker production.
- [ ] Dashboard giám sát lỗi, dung lượng, chi phí và cảnh báo.
- [ ] Cơ chế giải quyết xung đột (conflict resolution / branch UI) khi snapshot cloud có thay đổi đồng thời.
- [x] Đồng bộ template cá nhân lên Cloudflare R2 để dùng xuyên suốt nhiều máy (đóng gói ZIP bằng zlib Node.js, REST API trên Worker, lưu R2 & D1, đồng bộ hai chiều trên desktop).
- [ ] Thư viện mẫu cộng đồng (Community templates) tải từ cloud.
- [ ] Giao diện chỉnh sửa metadata và ảnh xem trước của template cá nhân.
- [ ] Onboard domain Email Sending thật cho Cloudflare Worker khi chuyển sang plan phù hợp.

## Đợt 6 — Web Client và Build LaTeX từ xa

- [ ] Web client (`latex-editor-web`) dùng chung giao thức xác thực, D1/R2 và Durable Objects room.
- [ ] Thiết kế cơ chế web session an toàn (CORS, CSRF, HTTP-only cookie).
- [ ] Dịch vụ LaTeX riêng biệt phía backend với môi trường sandbox cô lập tài nguyên (CPU, RAM, thời gian chạy).
- [ ] Hàng đợi biên dịch, trả log, file PDF và SyncTeX theo đúng phiên bản mã nguồn trên web.
- [ ] Đánh giá độ trễ và chi phí vận hành hạ tầng build từ xa.

