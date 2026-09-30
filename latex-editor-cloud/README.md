# LaTeX Editor Cloud

Backend Cloudflare Worker cho đăng nhập Google và lưu project + lịch sử Git trên R2. Đây không phải Git hosting server: mỗi lần đồng bộ gửi một Git bundle đầy đủ, không có giao thức Git push/pull hay merge phía server.

Code và kiểm thử đã có; **chưa deploy, chưa gắn tài khoản Google/R2 thật**. Test dùng Google giả lập và R2 trong bộ nhớ. Bạn cần tự cấu hình tài nguyên dưới đây để bật đăng nhập trong desktop.

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

Giữ các binding `PROJECTS`, `AUTH_RATE_LIMITER`, `PROJECT_RATE_LIMITER` trong `wrangler.toml`. Backend từ chối yêu cầu khi thiếu binding giới hạn tần suất; không tắt kiểm tra để chạy production.

Mở `https://YOUR-WORKER.workers.dev/health` để kiểm tra service/protocol và `configured`. Health không thay thế việc xác minh Google redirect URI/consent screen. Sau đó đặt `LATEX_EDITOR_API_URL` trong terminal khởi động desktop như [hướng dẫn desktop](../latex-editor-desktop/README.md).

Kiểm thử nghiệm thu trên dịch vụ thật: đăng nhập Google → tạo snapshot → tải lên → tải bản sao → kiểm tra file và lịch sử → đăng xuất → đăng nhập lại. Thử tài khoản thứ hai để kiểm tra project không bị lẫn; thử hai bản sao cùng sửa để xác nhận báo xung đột. Không chạy nghiệm thu bằng tài liệu có dữ liệu nhạy cảm.

## Lưu trữ và vận hành

- `auth/login/`, `auth/code/`, `auth/session/`: trạng thái đăng nhập, mã dùng một lần và token phiên dạng hash. TTL logic lần lượt 3 phút, 1 phút và 7 ngày. Google access token không được lưu; Google client secret nằm trong Worker secret.
- `users/<hash-user-id>/projects/<uuid>.json`: manifest, tên, head, ETag và bundle hiện hành.
- `users/<hash-user-id>/bundles/<uuid>.bundle`: toàn bộ Git history. Bản trước được giữ lại; dung lượng tăng theo số lần sync, không chỉ theo chênh lệch file.
- Nên cấu hình lifecycle **chỉ prefix `auth/`** xóa object sau 8 ngày. Backend vẫn từ chối phiên hết hạn ngay cả khi chưa dọn object. Không áp lifecycle xóa tùy tiện cho `users/` vì có thể làm mất bundle manifest đang tham chiếu.
- Chưa có quota theo tài khoản, garbage collection bundle, xóa tài khoản/project, backup tự động, refresh token, merge hoặc cộng tác. Theo dõi dung lượng/chi phí R2 và rate limits; cần bổ sung quota/retention trước khi mở đăng ký rộng rãi.
- Giới hạn bundle 50 MiB, snapshot 50 MiB/5.000 file ở desktop. Server kiểm tra header/metadata bundle; desktop xác minh Git objects và đường dẫn trước khi ghi bản sao. Test chưa tải thực tế bundle cực đại trên Workers: cần load test theo plan tài khoản trước khi tăng quy mô.
- R2 không có nghĩa là mã hóa đầu-cuối: Worker và quản trị tài khoản có thể đọc dữ liệu project. Không tải tài liệu/bí mật lên dịch vụ nếu mô hình này không phù hợp.

## API hiện có

| Route | Chức năng |
| --- | --- |
| `GET /health` | Trạng thái cấu hình công khai |
| `GET /auth/google/start`, `GET /auth/google/callback` | Luồng Google OAuth |
| `POST /auth/exchange` | Đổi mã một lần + PKCE lấy phiên |
| `POST /auth/logout`, `GET /v1/me` | Thu hồi phiên / tài khoản hiện tại |
| `GET /v1/projects?cursor=...` | Danh sách phân trang, 25 project/trang |
| `GET /v1/projects/:id/meta` | Manifest + ETag |
| `GET /v1/projects/:id` | Tải bundle |
| `PUT /v1/projects/:id` | Tải lên có `If-Match` hoặc `If-None-Match: *` |

Các route tài khoản/project dùng Bearer token. Xung đột ghi trả `409`, phiên thiếu/hết hạn trả `401`. Backend hiện dành cho desktop; web app tương lai cần thiết kế thêm browser session/CORS/CSRF, không đưa token này tùy tiện vào localStorage.

Tài liệu nhà cung cấp: [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server), [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
