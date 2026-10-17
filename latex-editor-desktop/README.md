# LaTeX Editor Desktop

Ứng dụng Electron cloud-first để sửa, biên dịch và xem tài liệu LaTeX trong giao diện VS Code nhúng qua code-server. Project có bản làm việc local, lịch sử được đồng bộ lên R2 và cộng tác Yjs với presence, cursor/selection cùng manifest file có tombstone.

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

Mặc định dữ liệu nằm trong `%APPDATA%\LatexEditor`. Lịch sử local dùng Git; Google login, đồng bộ R2 và cộng tác thời gian thực cần [backend](../latex-editor-cloud/README.md).

Xem thêm [docs/development.md](docs/development.md) và [docs/architecture.md](docs/architecture.md).

## Project và mẫu tài liệu

- **Project mới**: yêu cầu đăng nhập; app tạo bản làm việc local, lập phiên bản đầu tiên và tự tải toàn bộ source/lịch sử lên R2. Thư viện 7 mẫu có ảnh xem trước kết quả PDF, tìm kiếm có/không dấu và lọc theo loại tài liệu. Gồm Bài báo, Báo cáo, Slide Beamer, Tài liệu tối giản, Báo cáo tiếng Việt, Luận văn tiếng Việt và CV tiếng Việt.
- Mỗi mẫu hiển thị ngôn ngữ và compiler. Các mẫu tiếng Việt và Slide được cấu hình sẵn XeLaTeX cùng font Latin Modern để nhập Unicode tiếng Việt; chạy hai lượt khi cần cập nhật mục lục/tham chiếu. Cấu hình XeLaTeX được giữ khi mở lại project. Với MiKTeX, recipe do app quản lý tự cài package còn thiếu mà không bật hộp thoại hỏi lại.
- Trong hộp **Project mới**, bấm **Nhập ZIP** để thêm template hoặc **Lưu project làm mẫu** để tái sử dụng project đang mở. Template cá nhân nằm ở `%APPDATA%\LatexEditor\templates` và có thể đồng bộ lên R2 khi đăng nhập.
- Bấm **Chỉnh sửa** trên thẻ template cá nhân để đổi tên, mô tả, ngôn ngữ, compiler và ảnh PNG (tối đa 2 MiB, 4096 × 4096). **Lưu** chỉ lưu trên máy; **Lưu và đồng bộ** cập nhật bản cloud, giữ nguyên ID và nội dung tài liệu. Nếu upload lỗi, bản đã lưu trên máy vẫn được giữ. Trên máy khác, tải lại mẫu từ cloud để nhận thay đổi; đồng bộ thư viện không tự hợp nhất hai bản cùng ID.
- ZIP có thể đặt `main.tex` ở gốc hoặc trong một thư mục bọc duy nhất. App giới hạn 500 file, 50 MiB tổng và 10 MiB mỗi file; từ chối đường dẫn vượt thư mục, file mã hóa/symlink, đồng thời bỏ `.git`, `.vscode`, `.latex-editor`, `build`, `node_modules`, `.env*` và khóa riêng.
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

Khi khôi phục lịch sử của project đang cộng tác, app yêu cầu room online và quyền owner/editor, hiển thị số người đang online, sau đó thay manifest cùng draft Yjs bằng snapshot trên ổ đĩa. App chỉ báo hoàn tất sau khi Worker xác nhận manifest và từng document; viewer hoặc trạng thái offline bị chặn trước khi file local bị thay đổi.

## Đăng nhập và đồng bộ

Bản ứng dụng dùng Worker đã deploy tại `https://latex-editor-cloud.emsidt.workers.dev`, vì vậy chạy `npm start` là có thể đăng nhập. Khi phát triển với backend khác, ghi đè URL trước khi khởi động:

```powershell
$env:LATEX_EDITOR_API_URL = "http://127.0.0.1:8787"
npm start
```

- Bấm **Tài khoản** (☁) → **Đăng nhập bằng Google**; hoàn tất trong trình duyệt hệ thống. Có thể hủy lượt đăng nhập đang chờ.
- Project mới được tải lên cloud ngay khi tạo. Mỗi lần bấm **Lưu phiên bản** hoặc khôi phục lịch sử, app tự tải toàn bộ source và lịch sử dưới dạng Git bundle lên R2. Nút **Đồng bộ project đang mở** dùng để thử lại khi mạng/R2 từng bị lỗi hoặc để chụp nhanh nội dung đã Ctrl+S mà chưa lưu phiên bản.
- **Tải bản sao** tạo thư mục mới kèm lịch sử; không ghi đè project đang có. Bản sao có thể được chỉnh sửa rồi đồng bộ tiếp.
- Nếu cloud đã đổi từ máy khác, app báo xung đột. Tải bản sao cloud, đối chiếu/chuyển thay đổi cần giữ sang bản mới rồi tải lên từ bản đó. Chưa có merge tự động hay branch UI.
- Đăng xuất giữ nguyên project/lịch sử local, xóa phiên trên máy và yêu cầu server thu hồi token. Nếu offline, app cảnh báo chưa thu hồi được token server. Phiên có hạn 7 ngày; Worker mới hỗ trợ gia hạn khi còn dưới 24 giờ, tối đa 30 ngày từ lần đăng nhập Google.
- Mục Tài khoản & Cloud có dung lượng sử dụng và nút Xóa tài khoản. Server phải được [nâng cấp vận hành](../latex-editor-cloud/OPERATIONS.md) trước khi dùng các chức năng này. Xóa tài khoản thu hồi mọi phiên, dọn dữ liệu cloud theo lịch, giữ bản local; project có owner khác không bị xóa.

Phiên đăng nhập được mã hóa bằng Electron safeStorage trong `auth-session.bin`; nếu máy không có cơ chế mã hóa phù hợp, chỉ giữ trong bộ nhớ. Token không được gửi xuống renderer. Không nhập Google client secret hoặc khóa R2 vào desktop. Một project đã liên kết cloud không tự chuyển sang tài khoản/backend khác khi đổi đăng nhập.

Khi cần chẩn đoán kết nối mà không sửa dữ liệu cloud, chạy `npm run check:cloud --workspace latex-editor-desktop` từ thư mục gốc. Lệnh chỉ báo trạng thái Worker, session và khả năng đọc các API project/template; không in token đăng nhập.

## Chia sẻ project

- Project mới đã được đồng bộ lên cloud trong lúc tạo; sau đó bấm **Chia sẻ** để xem thành viên và quyền hiện tại.
- Owner có thể mời theo email hoặc tạo mã link với quyền editor/viewer, thu hồi lời mời và xóa thành viên.
- Mã link gồm invitation ID và token bí mật; phải sao chép toàn bộ chuỗi `id:token`. Email invitation chỉ tài khoản Google có đúng địa chỉ nhận mới chấp nhận được.
- Khi Email Sending đã được cấu hình ở Worker, người nhận nhận email HTML/text kèm trang hướng dẫn. Nếu dịch vụ email chưa sẵn sàng, lời mời vẫn xuất hiện trong mục **Tài khoản & Cloud** sau khi người nhận đăng nhập.
- Project cloud có cộng tác thời gian thực cho các file `.tex`, `.bib`, `.sty`, `.cls`, `.md`; tạo/đổi tên/xóa được đồng bộ qua manifest. Hàng đợi thao tác được lưu theo workspace, gửi lại sau khi mở app và Worker khử thao tác trùng bằng operation ID. File bị xóa từ phiên cộng tác được đưa vào Recycle Bin trên máy nhận.
