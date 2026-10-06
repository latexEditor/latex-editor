# Lộ trình cộng tác và thư viện mẫu

## Đợt 1 — Thư viện mẫu

- [x] Phân loại, tìm kiếm không dấu, thông tin ngôn ngữ và compiler.
- [x] Báo cáo tiếng Việt, luận văn tiếng Việt và CV; XeLaTeX cho Unicode.
- [x] Giữ cấu hình compiler khi mở lại project.
- [x] Ảnh xem trước trang đầu được render từ PDF thật của từng mẫu.
- [ ] Nhập mẫu từ ZIP và lưu project thành mẫu cá nhân.

## Đợt 2 — Project dùng chung

- [ ] Project ID dùng chung, migration dữ liệu cloud hiện đang nằm dưới từng tài khoản.
- [ ] D1 lưu project, thành viên, lời mời và quyền owner/editor/viewer.
- [ ] Mời qua email/link, chấp nhận lời mời, thu hồi quyền và project được chia sẻ.
- [ ] Kiểm tra quyền phía server cho mọi thao tác; kiểm thử bằng hai tài khoản.

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

R2 tiếp tục lưu tệp lớn và snapshot. Việc cùng chỉnh sửa cần cơ chế hợp nhất và điều phối riêng; đồng bộ Git bundle hiện tại chưa có tính năng đó.
