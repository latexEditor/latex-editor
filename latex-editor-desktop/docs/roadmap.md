# Lộ trình cộng tác và thư viện mẫu

## Đợt 1 — Thư viện mẫu

- [x] Phân loại, tìm kiếm không dấu, thông tin ngôn ngữ và compiler.
- [x] Báo cáo tiếng Việt, luận văn tiếng Việt và CV; XeLaTeX cho Unicode.
- [x] Giữ cấu hình compiler khi mở lại project.
- [x] Ảnh xem trước trang đầu được render từ PDF thật của từng mẫu.
- [ ] Nhập mẫu từ ZIP và lưu project thành mẫu cá nhân.

## Đợt 2 — Project dùng chung

- [x] D1 lưu user, session, project manifest, thành viên và lời mời; R2 chỉ lưu Git bundle và auth state tạm.
- [x] Bảng `project_members` với quyền owner/editor/viewer; kiểm tra quyền phía server cho mọi thao tác.
- [x] API mời qua email, chấp nhận lời mời, thu hồi lời mời, xóa thành viên.
- [x] Test bao gồm: cô lập project theo tài khoản, mời/chấp nhận/thu hồi, quyền viewer/editor/owner, ngăn xóa owner cuối.
- [x] Project ID dùng chung (chuyển sang bảng `projects` toàn cục kết hợp `project_members`, R2 bundle key dạng `bundles/:projectId/:uuid.bundle`).
- [x] Mời qua link (hỗ trợ cả API backend và UI desktop tạo/sao chép/nhập mã tham gia).
- [x] Giao diện desktop cho chia sẻ project và quản lý thành viên (hộp thoại Chia sẻ, danh sách thành viên kèm role badge, mời qua email/link, thu hồi và xóa thành viên).
- [x] Môi trường Worker & D1 thật đã được tạo và deploy trên Cloudflare (`latex-editor-db`, binding `DB`, 5 bảng).
- [ ] Kiểm thử nghiệm thu bằng hai tài khoản trên Worker thật (đăng nhập Google, tạo và chia sẻ project qua link/email).

## Đợt 3 — Cộng tác thời gian thực

- [ ] Phiên project dùng Durable Objects + WebSocket, hợp nhất nội dung với Yjs.
- [ ] Extension code-server kết nối nội dung editor, con trỏ và trạng thái online.
- [ ] Đồng bộ tạo/xóa/đổi tên file, lưu nội dung và phục hồi sau mất kết nối.
- [ ] Phân biệt bản nháp cộng tác với snapshot lịch sử; không ghi đè phiên đang sửa bằng Git bundle cũ.
- [ ] Thử nghiệm hai người sửa cùng dòng; thu hồi quyền và kết nối lại.

## Đợt 4 — Web và build từ xa

- [ ] Web client dùng cùng xác thực, project và giao thức cộng tác.
- [ ] Dịch vụ LaTeX riêng với môi trường build cô lập và giới hạn tài nguyên.
- [ ] Hàng đợi build, log lỗi, PDF và SyncTeX theo đúng phiên bản nguồn.
- [ ] Triển khai thử nghiệm, đo độ trễ và chi phí trước khi mở rộng.

R2 tiếp tục lưu Git bundle và auth state tạm. D1 SQLite lưu toàn bộ structured data (user, session, project metadata, team). Việc cùng chỉnh sửa cần cơ chế hợp nhất và điều phối riêng; đồng bộ Git bundle hiện tại chưa có tính năng đó.
