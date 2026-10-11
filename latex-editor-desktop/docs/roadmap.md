# Lộ trình cộng tác và thư viện mẫu

## Đợt 1 — Thư viện mẫu

- [x] Phân loại, tìm kiếm không dấu, thông tin ngôn ngữ và compiler.
- [x] Báo cáo tiếng Việt, luận văn tiếng Việt và CV; XeLaTeX cho Unicode.
- [x] Giữ cấu hình compiler khi mở lại project.
- [x] Ảnh xem trước trang đầu được render từ PDF thật của từng mẫu.
- [x] Nhập mẫu từ ZIP và lưu project thành mẫu cá nhân; kiểm tra đường dẫn, dung lượng, symlink và loại dữ liệu sinh ra/bí mật.

## Đợt 2 — Project dùng chung

- [x] D1 lưu user, session, project manifest, thành viên và lời mời; R2 chỉ lưu Git bundle và auth state tạm.
- [x] Bảng `project_members` với quyền owner/editor/viewer; kiểm tra quyền phía server cho mọi thao tác.
- [x] API mời qua email, chấp nhận lời mời, thu hồi lời mời, xóa thành viên.
- [x] Test bao gồm: cô lập project theo tài khoản, mời/chấp nhận/thu hồi, quyền viewer/editor/owner, ngăn xóa owner cuối.
- [x] Project ID dùng chung (chuyển sang bảng `projects` toàn cục kết hợp `project_members`, R2 bundle key dạng `bundles/:projectId/:uuid.bundle`).
- [x] Project mới yêu cầu đăng nhập, tự tạo snapshot/upload lên R2; lưu hoặc khôi phục lịch sử tự đồng bộ lại và vẫn giữ bản local khi mạng lỗi.
- [x] Mời qua link (hỗ trợ cả API backend và UI desktop tạo/sao chép/nhập mã tham gia).
- [x] Giao diện desktop cho chia sẻ project và quản lý thành viên (hộp thoại Chia sẻ, danh sách thành viên kèm role badge, mời qua email/link, thu hồi và xóa thành viên).
- [x] Môi trường Worker & D1 thật đã được tạo và deploy trên Cloudflare (`latex-editor-db`, binding `DB`, 5 bảng).
- [x] Test Electron cho giao diện mời, chấp nhận bằng tài khoản thứ hai, danh sách thành viên, xóa thành viên và thu hồi link mời.
- [x] Worker tạo email transactional dạng text + HTML và trang hướng dẫn nhận lời mời; tự hạ cấp về thông báo trong app khi binding email chưa sẵn sàng.
- [x] Link mời dùng cặp invitation ID + token bí mật; server xác minh token trước khi thêm thành viên.
- [ ] Onboard domain Email Sending, thêm binding `EMAIL`/`EMAIL_FROM` và kiểm tra thư thật (tài khoản Cloudflare hiện trả `Unauthorized 2036` cho Email Sending).
- [ ] Kiểm thử nghiệm thu bằng hai tài khoản trên Worker thật (đăng nhập Google, tạo và chia sẻ project qua link/email).

## Đợt 3 — Cộng tác thời gian thực

- [x] Phiên project dùng Durable Objects + WebSocket: room theo project xác thực thành viên, presence, cursor/selection, ngắt kết nối khi thu hồi quyền, lưu draft Yjs theo file và tự hoàn tất cleanup còn dang dở sau khi room khởi động lại.
- [x] Desktop kết nối room, hiển thị người online, cursor/selection và extension code-server đồng bộ nội dung `.tex/.bib/.sty/.cls/.md`; viewer bị chặn ghi và client tự kết nối lại với exponential backoff.
- [x] Đồng bộ tạo/xóa/đổi tên file qua manifest có revision và tombstone; hàng đợi thao tác lưu trong workspace state, gửi lại sau khi mở app và chỉ xóa khi Worker ACK theo operation ID.
- [x] Phân biệt draft cộng tác với snapshot lịch sử: restore yêu cầu room online và quyền ghi, xác nhận số người bị ảnh hưởng, reset manifest/document rồi chờ đủ ACK trước khi upload bundle mới.
- [x] Kiểm thử hai editor sửa cùng vị trí rồi reconnect vẫn hội tụ; kiểm thử thu hồi quyền ngắt phiên và chặn non-member kết nối lại.

## Đợt 4 — Web và build từ xa

- [ ] Web client dùng cùng xác thực, project và giao thức cộng tác.
- [ ] Dịch vụ LaTeX riêng với môi trường build cô lập và giới hạn tài nguyên.
- [ ] Hàng đợi build, log lỗi, PDF và SyncTeX theo đúng phiên bản nguồn.
- [ ] Triển khai thử nghiệm, đo độ trễ và chi phí trước khi mở rộng.

R2 tiếp tục lưu Git bundle và auth state tạm. D1 SQLite lưu toàn bộ structured data (user, session, project metadata, team). Việc cùng chỉnh sửa cần cơ chế hợp nhất và điều phối riêng; đồng bộ Git bundle hiện tại chưa có tính năng đó.
