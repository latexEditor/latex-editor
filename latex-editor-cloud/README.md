# LaTeX Editor Cloud

Ngoài Git bundle riêng tư của project, Worker hỗ trợ xuất bản PDF kết quả thành
object R2 riêng qua `/v1/projects/:id/publication`. Link ngẫu nhiên `/p/:id` chỉ
trả PDF, không yêu cầu đăng nhập và không cấp quyền xem source/lịch sử. Owner và
editor có thể cập nhật cùng một link, đặt hạn tối đa 365 ngày hoặc thu hồi ngay.

Khi nâng cấp môi trường đã tồn tại, áp dụng
`migrations/0002_pdf_publications.sql` trước khi deploy Worker mới.

Backend Cloudflare Worker cho đăng nhập Google và lưu project + lịch sử Git trên R2. Đây không phải Git hosting server: mỗi lần đồng bộ gửi một Git bundle đầy đủ, không có giao thức Git push/pull hay merge phía server.

Worker production đã được deploy với Google OAuth, D1 và R2. Test tự động vẫn dùng Google/D1/R2/email giả lập để không thay đổi dữ liệu production; luồng chia sẻ cần được nghiệm thu thêm bằng hai tài khoản Google thật.

Phần quota, dọn R2 theo lịch, gia hạn phiên và xóa tài khoản đã có trong code mới;
cần áp migration trước deploy. Xem [hướng dẫn vận hành](OPERATIONS.md) để biết
cách nâng cấp và các bước còn thiếu cho backup tự động. Bộ test vận hành riêng
dùng SQLite thật qua Node 22, không dùng dữ liệu production.

## 1. Công cụ và tài nguyên

Desktop tiếp tục dùng Node 20.19.5. Wrangler 4.120.0 cần Node 22 trở lên; không cần đổi Node của desktop. Trong thư mục `latex-editor-cloud`, có thể dùng Wrangler với Node 22 biệt lập qua npm:

```powershell
npm exec --yes --package=node@22 --package=wrangler@4.120.0 -- wrangler login
npm exec --yes --package=node@22 --package=wrangler@4.120.0 -- wrangler r2 bucket create latex-editor-projects
```

Lệnh đầu mở đăng nhập Cloudflare; lệnh sau tạo bucket thật. Nếu đã có bucket riêng, đặt đúng tên trong `wrangler.toml`. Không bật public access cho bucket. R2 có thể yêu cầu kích hoạt billing; kiểm tra chi phí/quota trên tài khoản của bạn trước khi triển khai.

`npm run dev/deploy` dành cho terminal đã có Node 22+. Không nâng Node desktop hoặc cài lại code-server bằng Node khác chỉ để chạy backend.

## 2. Google OAuth

Trong Google Cloud Console, tạo project/consent screen cho ứng dụng và OAuth client loại **Web application**. Nếu consent screen đang ở Testing, thêm email được phép vào Test users.

Đặt Authorized redirect URI chính xác:

```text
https://YOUR-WORKER.workers.dev/auth/google/callback
```

URI đăng ký với Google là callback HTTPS của Worker, không phải loopback có port ngẫu nhiên trên máy người dùng. Worker dùng các scope `openid email profile`.

Sửa hai giá trị công khai trong `wrangler.toml`:

```toml
[vars]
PUBLIC_BASE_URL = "https://YOUR-WORKER.workers.dev"
GOOGLE_CLIENT_ID = "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
```

`PUBLIC_BASE_URL` không có dấu `/` cuối, phải khớp origin deploy. Tên Worker/subdomain phải đúng tài khoản của bạn. Client secret chỉ đưa vào Workers Secrets, tuyệt đối không commit:

```powershell
npm exec --yes --package=node@22 --package=wrangler@4.120.0 -- wrangler secret put GOOGLE_CLIENT_SECRET
```

Nếu Worker chưa tồn tại, có thể deploy cấu hình công khai trước, rồi đặt secret; login sẽ không hoạt động cho tới khi secret được đặt. Không gửi secret qua chat, không đặt trong renderer hoặc cấu hình desktop.

## 3. Kiểm tra và deploy

Từ thư mục `latex-editor-cloud`:

```powershell
npm test
npm run check
npm exec --yes --package=node@22 --package=wrangler@4.120.0 -- wrangler deploy --dry-run
# Lệnh dưới triển khai thật vào tài khoản đang đăng nhập:
npm exec --yes --package=node@22 --package=wrangler@4.120.0 -- wrangler deploy
```

Giữ các binding `PROJECTS`, `DB`, `COLLABORATION_ROOMS`, `AUTH_RATE_LIMITER`, `PROJECT_RATE_LIMITER` trong `wrangler.toml`. `COLLABORATION_ROOMS` dùng migration SQLite `v1`; lần deploy đầu sẽ tạo lớp Durable Object cho phòng cộng tác theo từng project. Backend từ chối yêu cầu khi thiếu binding giới hạn tần suất; không tắt kiểm tra để chạy production.

Mở `https://YOUR-WORKER.workers.dev/health` để kiểm tra service/protocol và `configured`. Health không thay thế việc xác minh Google redirect URI/consent screen. Sau đó đặt `LATEX_EDITOR_API_URL` trong terminal khởi động desktop như [hướng dẫn desktop](../latex-editor-desktop/README.md).

Kiểm thử nghiệm thu trên dịch vụ thật: đăng nhập Google → tạo snapshot → tải lên → tải bản sao → kiểm tra file và lịch sử → đăng xuất → đăng nhập lại. Thử tài khoản thứ hai để kiểm tra project không bị lẫn; thử hai bản sao cùng sửa để xác nhận báo xung đột. Không chạy nghiệm thu bằng tài liệu có dữ liệu nhạy cảm.

## Email lời mời

Worker đã hỗ trợ Cloudflare Email Sending binding và gửi cả bản text lẫn HTML. Để bật gửi thật, tài khoản phải dùng Workers Paid và có một domain dùng Cloudflare DNS đã được onboard tại **Compute → Email Service → Email Sending**. Sau đó thêm vào `wrangler.toml`:

```toml
[vars]
EMAIL_FROM = "invites@your-domain.example"
EMAIL_FROM_NAME = "LaTeX Editor"

[[send_email]]
name = "EMAIL"
```

Không dùng `workers.dev` làm domain người gửi. Nếu binding hoặc `EMAIL_FROM` chưa có, lời mời vẫn được lưu và hiện trong app nhưng API trả `delivery.sent = false`; giao diện không tuyên bố rằng email đã được gửi. `GET /health` trả thêm `emailConfigured` để kiểm tra trạng thái.

## Lưu trữ và vận hành

- **Cơ sở dữ liệu D1 (`latex-editor-db`)**:
  - `users`: Tài khoản người dùng (id, email, name, avatar_url).
  - `sessions`: Quản lý phiên token băm với thời hạn 7 ngày.
  - `projects`: ID toàn cục, tên project, commit head, bundle_key trỏ sang R2, updated_at dùng để phát hiện xung đột (`If-Match`).
  - `project_members`: Phân quyền theo cặp `(project_id, user_id)` gồm `owner`, `editor`, `viewer`. Ngăn chặn xóa owner cuối cùng.
  - `invitations`: Quản lý lời mời qua email hoặc link bí mật (`token_hash`), trạng thái `pending`/`accepted`/`revoked`.
  - `user_templates`: Danh sách template cá nhân của người dùng (id, user_id, name, description, category, main_file, preview_url, storage_key, version, updated_at).
- **Lưu trữ R2 (`latex-editor-projects`)**:
  - `auth/login/`, `auth/code/`: Trạng thái OAuth tạm và mã trao đổi một lần (TTL lần lượt 3 phút và 1 phút, tiêu thụ bằng conditional write).
  - `bundles/:projectId/:uuid.bundle`: Toàn bộ Git history được đóng gói thành Git bundle v2.
  - `templates/:userId/:templateId.zip`: Lưu trữ file ZIP đóng gói template cá nhân của người dùng.
  - `publications/:projectId/:uuid.pdf`: PDF kết quả tách khỏi Git bundle; Worker chỉ phục vụ qua link `/p/:publicationId` khó đoán.
  - Lifecycle: Chỉ cấu hình lifecycle xóa tự động đối với prefix `auth/` sau 8 ngày. Không áp lifecycle tự động cho `bundles/` hoặc `publications/`; cron đối chiếu tham chiếu D1 và thời hạn link trước khi xóa.
- **Durable Objects (`ProjectCollaborationRoom`)**:
  - Mỗi project được điều phối bởi một Durable Object riêng biệt.
  - Lưu trữ SQLite nội bộ: Draft tài liệu Yjs (`document:<path>`), file manifest có tombstone (`manifest:v1`), và hàng đợi thao tác đã khử trùng lặp qua operation ID.
  - Quản lý phiên WebSocket, tự phục hồi presence từ WebSocket attachment khi hibernating/khởi động lại.
- **Giới hạn hiện tại**:
  - Đã có: Cộng tác thời gian thực Yjs, đồng bộ file manifest, phân quyền server, xóa project cloud an toàn (xóa Durable Object room, thu hồi bundle R2 và D1 cascade delete), đồng bộ template cá nhân qua R2/D1.
  - Vận hành mới (cần migration/deploy): quota 1 GiB/tài khoản và 500 MiB/project, cron GC, API xóa tài khoản, gia hạn session giới hạn 30 ngày, Logs/Traces.
  - Backup: script D1/R2 sang bucket private `latex-editor-backups`, checksum/restore local và workflow hằng ngày; lịch CI cần cấu hình secret và bật riêng theo [OPERATIONS.md](OPERATIONS.md).
  - Chưa có: backup draft Durable Objects, auto-merge snapshot, dashboard/cảnh báo chi phí riêng.
  - Giới hạn bundle: 50 MiB, tối đa 5.000 file/snapshot.

## API hiện có

| Route | Phương thức | Chức năng | Phân quyền |
| --- | --- | --- | --- |
| `GET /health` | GET | Trạng thái cấu hình cloud, email và cộng tác | Công khai |
| `GET /invite/:id` | GET | Trang HTML hướng dẫn mở mã lời mời trong desktop | Công khai |
| `GET /auth/google/start` | GET | Khởi động luồng Google OAuth PKCE | Công khai |
| `GET /auth/google/callback` | GET | Nhận callback Google và chuyển tiếp về loopback desktop | Công khai |
| `POST /auth/exchange` | POST | Đổi mã một lần + PKCE lấy token phiên | Công khai |
| `POST /auth/logout` | POST | Thu hồi phiên đăng nhập hiện tại | Đã xác thực |
| `GET /v1/me` | GET | Lấy thông tin tài khoản đang đăng nhập | Đã xác thực |
| `GET /v1/projects?cursor=...` | GET | Danh sách project phân trang (25 project/trang) | Đã xác thực |
| `PUT /v1/projects/:id` | PUT | Tạo project mới (`If-None-Match: *`) hoặc Cập nhật snapshot (`If-Match`) | Owner / Editor |
| `DELETE /v1/projects/:id` | DELETE | Xóa project khỏi Cloud (xóa DO room, purge R2 bundles, D1 cascade delete) | Owner |
| `GET /v1/projects/:id` | GET | Tải Git bundle đầy đủ của project | Thành viên |
| `GET /v1/projects/:id/meta` | GET | Lấy manifest, head commit, updated_at, role và ETag | Thành viên |
| `GET /v1/projects/:id/publication` | GET | Xem metadata và link PDF kết quả hiện tại | Thành viên |
| `PUT /v1/projects/:id/publication` | PUT | Xuất bản/cập nhật PDF gắn với Git head hiện tại | Owner / Editor |
| `DELETE /v1/projects/:id/publication` | DELETE | Thu hồi link và dọn PDF đã xuất bản | Owner / Editor |
| `GET /p/:publicationId` | GET/HEAD | Xem trực tiếp PDF bằng link khó đoán, không lộ source | Công khai theo link |
| `GET /v1/projects/:id/members` | GET | Danh sách thành viên và vai trò | Thành viên |
| `DELETE /v1/projects/:id/members/:userId` | DELETE | Xóa thành viên khỏi project (hoặc tự rời project) | Owner (hoặc chính user) |
| `POST /v1/projects/:id/invite` | POST | Tạo lời mời qua email hoặc tạo link bí mật (`id:token`) | Owner |
| `GET /v1/projects/:id/invitations` | GET | Danh sách lời mời đang có của project | Owner |
| `POST /v1/projects/:id/invitations/:id/revoke` | POST | Thu hồi lời mời đang chờ | Owner |
| `POST /v1/invitations/:id/accept` | POST | Chấp nhận lời mời (link mời cần kèm token trong body) | Đã xác thực |
| `POST /v1/invitations/:id/decline` | POST | Từ chối lời mời qua email | Đã xác thực |
| `GET /v1/projects/:id/collaboration` | GET (WS) | Kết nối WebSocket vào phòng cộng tác Yjs & Presence | Thành viên |
| `GET /v1/projects/:id/collaboration/presence` | GET | Xem danh sách thành viên đang online | Thành viên |
| `GET /v1/templates` | GET | Lấy danh sách template cá nhân trên cloud của user | Đã xác thực |
| `PUT /v1/templates/:id` | PUT | Tải lên file ZIP đóng gói template cá nhân và lưu metadata | Đã xác thực |
| `GET /v1/templates/:id` | GET | Tải xuống file ZIP template cá nhân từ R2 | Đã xác thực |
| `DELETE /v1/templates/:id` | DELETE | Xóa template cá nhân khỏi R2 và D1 | Đã xác thực |

Các route tài khoản/project dùng Bearer token. Xung đột ghi trả `409`, phiên thiếu/hết hạn trả `401`. Backend hiện dành cho desktop; web app tương lai cần thiết kế thêm browser session/CORS/CSRF, không đưa token này tùy tiện vào localStorage.

Tài liệu nhà cung cấp: [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server), [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
