# LaTeX Editor Desktop

Ứng dụng Electron local-first để sửa, biên dịch và xem tài liệu LaTeX trong giao diện VS Code nhúng qua code-server.

## Yêu cầu

Windows 10/11 x64, Git for Windows, Node.js **20.19.5**, cùng MiKTeX hoặc TeX Live có binary trong `PATH`.

## Cài đặt và chạy

Từ thư mục gốc monorepo:

```powershell
npm install
npm run setup:desktop
npm start
```

Hoặc chạy trực tiếp trong thư mục này:

```powershell
npm run setup:code-server
npm run setup:latex-workshop
npm run check:latex
npm start
```

Mặc định dữ liệu nằm trong `%APPDATA%\LatexEditor`. Lịch sử local dùng Git; Google login và đồng bộ R2 cần cấu hình [backend riêng](../latex-editor-cloud/README.md). Chưa hỗ trợ cộng tác thời gian thực.

Xem thêm [docs/development.md](docs/development.md) và [docs/architecture.md](docs/architecture.md).

## Project và mẫu tài liệu

- **Project mới**: thư viện 7 mẫu có ảnh xem trước kết quả PDF, tìm kiếm có/không dấu và lọc theo loại tài liệu. Gồm Bài báo, Báo cáo, Slide Beamer, Tài liệu tối giản, Báo cáo tiếng Việt, Luận văn tiếng Việt và CV tiếng Việt.
- Mỗi mẫu hiển thị ngôn ngữ và compiler. Ba mẫu tiếng Việt được cấu hình sẵn XeLaTeX và font Latin Modern Roman; chạy hai lượt để cập nhật mục lục/tham chiếu. Cấu hình XeLaTeX được giữ khi mở lại project.
- Nếu thiếu compiler của mẫu, hộp tạo project hiển thị hướng dẫn; vẫn có thể tạo để soạn nội dung. Mẫu luận văn là cấu trúc chung, cần điều chỉnh theo yêu cầu của trường.
- **Gần đây**: tìm theo tên/đường dẫn và mở lại tối đa 12 project gần nhất, kể cả sau khi khởi động lại app. Trang trống hiển thị 5 project gần nhất để mở nhanh.
- **Vị trí** mở thư mục project trong File Explorer. **Mở nơi lưu project** mở thư mục gốc, mặc định là `%APPDATA%\LatexEditor\projects` (có thể thay đổi bằng `LATEX_EDITOR_PROJECTS_DIR`). Hộp thoại luôn hiển thị đường dẫn thực tế đang dùng.
- **Bỏ** chỉ gỡ project khỏi lịch sử; file và tab đang mở vẫn được giữ lại. Thư mục bị di chuyển/xóa được đánh dấu để bạn có thể bỏ khỏi danh sách và mở lại vị trí mới.

Mẫu slide cần gói `beamer` và các phụ thuộc trong MiKTeX/TeX Live. Với mẫu báo cáo, nếu dùng recipe pdfLaTeX một lượt, build hai lần để cập nhật mục lục.

Xem [lộ trình triển khai](docs/roadmap.md) cho thư viện mẫu, chia sẻ project, cộng tác thời gian thực và bản web.

Kiểm tra logic bằng `npm test`. Chạy `npm run test:ui --workspace latex-editor-desktop` từ root để kiểm tra giao diện cùng preload/IPC thật trong một cửa sổ Electron ẩn, dùng project tạm riêng và không khởi động code-server.

## Lịch sử phiên bản

1. Mở project, nhấn **Ctrl+S** trong editor để lưu file xuống đĩa.
2. Bấm **Lịch sử** (biểu tượng ↶ ở cửa sổ nhỏ), nhập ghi chú rồi **Lưu phiên bản**.
3. Chọn một phiên bản để xem diff. **Khôi phục bản đã chọn** hỏi xác nhận, tạo một bản bảo vệ nội dung hiện tại trên đĩa rồi mới thay đổi file. Buffer chưa lưu trong editor không nằm trong bản bảo vệ.

Lịch sử nằm riêng ở `%APPDATA%\LatexEditor\history`, không sửa `.git` của project. Giao diện hiển thị 100 phiên bản gần nhất; bundle cloud chứa toàn bộ lịch sử. Project không thay đổi sẽ không tạo thêm commit thông thường. Bản bảo vệ/khôi phục vẫn có commit riêng.

Mỗi snapshot tối đa 50 MiB / 5.000 file, không hỗ trợ symlink/submodule. Bỏ qua thư mục `.git`, `build`, `node_modules`, `.latex-editor`, file `.env*`, một số file phụ trợ LaTeX và khóa `.pem/.key/.p12`. **Không dùng `.gitignore` của project để lọc snapshot; bộ lọc không bảo đảm phát hiện mọi bí mật.** Hãy kiểm tra nội dung trước khi tải cloud. PDF ngoài thư mục `build` vẫn có thể được lưu.

Lịch sử và liên kết cloud gắn với đường dẫn project. Khi tự di chuyển/đổi tên thư mục, app coi đó là project khác. Sao lưu cả thư mục project và `%APPDATA%\LatexEditor` nếu muốn giữ lịch sử/liên kết local.

## Đăng nhập và đồng bộ

Bản ứng dụng dùng Worker đã deploy tại `https://latex-editor-cloud.emsidt.workers.dev`, vì vậy chạy `npm start` là có thể đăng nhập. Khi phát triển với backend khác, ghi đè URL trước khi khởi động:

```powershell
$env:LATEX_EDITOR_API_URL = "http://127.0.0.1:8787"
npm start
```

- Bấm **Tài khoản** (☁) → **Đăng nhập bằng Google**; hoàn tất trong trình duyệt hệ thống. Có thể hủy lượt đăng nhập đang chờ.
- Lưu file bằng Ctrl+S rồi tải project đang mở lên cloud. App tạo snapshot nếu có thay đổi và tải cả lịch sử dưới dạng Git bundle. Đây là đồng bộ **thủ công**, không tự tải lên sau mỗi lần sửa.
- **Tải bản sao** tạo thư mục mới kèm lịch sử; không ghi đè project đang có. Bản sao có thể được chỉnh sửa rồi đồng bộ tiếp.
- Nếu cloud đã đổi từ máy khác, app báo xung đột. Tải bản sao cloud, đối chiếu/chuyển thay đổi cần giữ sang bản mới rồi tải lên từ bản đó. Chưa có merge tự động hay branch UI.
- Đăng xuất giữ nguyên project/lịch sử local, xóa phiên trên máy và yêu cầu server thu hồi token. Nếu offline, app cảnh báo chưa thu hồi được token server. Phiên có hạn 7 ngày.

Phiên đăng nhập được mã hóa bằng Electron safeStorage trong `auth-session.bin`; nếu máy không có cơ chế mã hóa phù hợp, chỉ giữ trong bộ nhớ. Token không được gửi xuống renderer. Không nhập Google client secret hoặc khóa R2 vào desktop. Một project đã liên kết cloud không tự chuyển sang tài khoản/backend khác khi đổi đăng nhập.
