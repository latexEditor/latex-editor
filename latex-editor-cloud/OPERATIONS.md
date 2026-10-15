# Vận hành cloud

## Trạng thái triển khai

Các thay đổi trong tài liệu này cần migration D1 và deploy Worker mới trước khi
có tác dụng trên production. Backup dùng bucket private `latex-editor-backups`
trong cùng tài khoản Cloudflare; lịch GitHub Actions cần bật riêng như bên dưới.

## Quota và cách tính dung lượng

- Mặc định: 1 GiB/tài khoản, 500 MiB/project, 50 MiB/lần upload.
- Chỉnh `ACCOUNT_STORAGE_BYTES` và `PROJECT_STORAGE_BYTES` trong `wrangler.toml`.
- Bao gồm project, template, upload đang chờ hoàn tất và bundle cũ chờ dọn.
  Đây không phải giới hạn dung lượng cả bucket Cloudflare, cũng không tính dữ
  liệu draft của Durable Objects. Giới hạn file/draft riêng vẫn áp dụng.
- Dung lượng project dùng chung tính cho owner, không tính lại cho từng editor.
- Worker giữ dung lượng bằng một câu lệnh SQLite nguyên tử trước khi ghi R2;
  upload đồng thời không thể cùng dùng phần dung lượng trống.
- Khi vượt quota trả HTTP 413. Bản local không bị xóa. Có thể xóa dữ liệu cloud,
  chờ tác vụ dọn dữ liệu hoặc tăng quota; snapshot Git bundle vẫn chứa toàn bộ
  lịch sử nên xóa bundle cũ không xóa các commit trong bundle hiện tại.
- Sau migration, bundle hiện hữu tạm được tính bảo thủ là 50 MiB. Cron đọc
  `R2.head/list` để điều chỉnh về kích thước thật, theo từng trang.
- `GET /v1/me/storage` và mục Tài khoản & Cloud hiển thị số đang được tính.

## Garbage collection và xóa tài khoản

- Cron chạy mỗi 15 phút UTC, luân phiên các cửa sổ dọn tài khoản và dọn R2.
- R2 được duyệt 24 object/lần, kiểm tra tham chiếu và xóa theo batch, lưu cursor trong D1 để tiếp tục ở lần sau.
  Với dữ liệu lớn, một vòng quét có thể kéo dài; không bảo đảm mọi object sẽ
  bị xóa ngay sau 24 giờ. Theo dõi tốc độ tăng dữ liệu để điều chỉnh batching.
- Chỉ xét prefix `auth/`, `bundles/`, `templates/`; bỏ qua object dưới 24 giờ
  và object vẫn được project/template tham chiếu trong D1.
- Template mới dùng key bất biến theo UUID để tránh GC xóa trúng bản mới.
- Reservation không có object trên R2 cũng được thu hồi sau thời gian chờ.
- Xóa tài khoản cần xác nhận bằng hộp thoại desktop và body
  `{ "confirm": "DELETE", "email": "email tài khoản" }` tại `DELETE /v1/me`.
- Server ghi marker và thu hồi mọi session trong một transaction. Lần đăng nhập
  mới bị chặn trong khi xóa. Các kết nối cộng tác được ngắt và retry nếu lỗi.
- Xóa theo batch, có thể tiếp tục sau khi lỗi hoặc Worker khởi động lại:
  project mà user là owner duy nhất bị xóa (kể cả đã chia sẻ); project có owner
  khác được giữ và chuyển phần dung lượng sang owner còn lại; template, lời mời,
  session và user record được dọn. Người dùng có thể đăng ký lại sau khi hoàn tất.
- Các bản local trên máy không bị xóa. Bundle mồ côi có từ trước migration
  được GC dọn sau khi không còn tham chiếu. Backup vận hành được lưu riêng;
  xóa tài khoản không xóa ngay các bản backup. Hiện chưa bật tự xóa backup,
  cần thống nhất retention trước khi bật lịch định kỳ.

## Gia hạn phiên

- Giữ token hiện tại ở Electron main process, mã hóa bằng safeStorage.
- Khi phiên còn dưới 24 giờ, desktop gọi `POST /auth/refresh`; các yêu cầu
  đồng thời dùng chung một lượt gia hạn, tối đa một lần/giờ.
- Gia hạn thêm tối đa 7 ngày nhưng không vượt 30 ngày từ lần đăng nhập Google.
  Hết hạn hoặc đã revoke phải đăng nhập Google lại. Không gia hạn phiên đã hết hạn.
- Đăng xuất trong lúc gia hạn không thể làm phiên đăng nhập sống lại.
- Không lưu Google access/refresh token, không gửi token phiên xuống renderer.

## Migration và deploy

Giữ Node 20 của desktop. Các lệnh bên dưới chạy từ thư mục repo bằng Node 22
cô lập và Wrangler đúng phiên bản hiện tại.

1. Kiểm thử:

   ```powershell
   npm --prefix latex-editor-cloud test
   npm exec --yes --package=node@22.12.0 -- node --experimental-sqlite --test latex-editor-cloud/test/operations.test.js
   npm exec --yes --package=node@22.12.0 -- node --experimental-sqlite --test latex-editor-cloud/test/backup.test.js
   npm test
   npm run check
   ```

2. Kiểm tra migration cục bộ (database mới cần tạo schema trước):

   ```powershell
   npm exec --yes --package=node@22.12.0 --package=wrangler@4.120.0 -- wrangler d1 execute latex-editor-db --local --config latex-editor-cloud/wrangler.toml --file latex-editor-cloud/schema.sql
   npm exec --yes --package=node@22.12.0 --package=wrangler@4.120.0 -- wrangler d1 migrations apply latex-editor-db --local --config latex-editor-cloud/wrangler.toml
   ```

3. Trước khi triển khai production, xác định bookmark Time Travel hoặc bản export
   D1 gần nhất và kiểm tra tài khoản Cloudflare đang dùng. Áp migration **trước**
   deploy Worker (migration chỉ bổ sung bảng, index và trigger):

   ```powershell
   npm exec --yes --package=node@22.12.0 --package=wrangler@4.120.0 -- wrangler d1 migrations apply latex-editor-db --remote --config latex-editor-cloud/wrangler.toml
   npm exec --yes --package=node@22.12.0 --package=wrangler@4.120.0 -- wrangler deploy --dry-run --config latex-editor-cloud/wrangler.toml
   npm exec --yes --package=node@22.12.0 --package=wrangler@4.120.0 -- wrangler deploy --config latex-editor-cloud/wrangler.toml
   ```

Không chạy lại file schema thay cho migration trên dữ liệu đang dùng.
Rollback Worker không rollback database hay khôi phục dữ liệu GC đã xóa.

## Theo dõi và xử lý lỗi

Worker bật Logs và lấy mẫu Traces 1%. Trong dashboard Cloudflare lọc các event
`cloud-maintenance`, `account-cleanup-retry`, `account-disconnect-pending`,
`request-failed`. Log không ghi token, nội dung tài liệu hay email người dùng.
`cloud_maintenance` lưu cursor và báo cáo lần chạy cuối (đọc bằng D1 Console).
Đây là dữ liệu vận hành cho chủ hệ thống, không có API admin công khai.

Khi cleanup lỗi, marker và reservation giữ nguyên để thử lại. Nếu thấy errors
tăng liên tục, kiểm tra binding/permission của D1, R2 và Durable Objects; không
xóa marker thủ công trước khi đối chiếu dữ liệu. Chưa có gửi cảnh báo tự động
hoặc dashboard chi phí riêng.

## Backup và kiểm tra khôi phục

- Đích cố định đã được chủ tài khoản cho phép: `latex-editor-backups`, account
  `a533b356d5a670c392fdc7dd9969c5c9`; tách biệt bucket `latex-editor-projects`.
- Không bật `r2.dev` hay custom domain cho bucket backup; không có route tải
  backup trong API công khai hoặc desktop. Không có credential trong Git.
- Tạo backup bằng `npm --prefix latex-editor-cloud run backup -- create`.
  Script dùng Node 22.12.0 và Wrangler 4.120.0 cô lập, không thay Node desktop.
- Script export D1, lấy key từ đúng bản export đó và sao chép bundle/template
  được tham chiếu. Mỗi file có kích thước và SHA-256; `manifest.json` được ghi
  cuối cùng. Nếu thiếu object hoặc upload lỗi, không công bố backup hoàn tất.
- Nếu D1 tham chiếu object đã bị thiếu ở source, vẫn giữ SQL và các object đọc
  được với marker `incomplete.json`, trả exit code 1 và không tạo `manifest.json`.
  Đây là snapshot phục vụ điều tra/khôi phục từng phần, không phải backup đầy đủ;
  cần đối chiếu bản local/lịch sử và sửa tham chiếu gốc trước khi chạy lại.
- Mỗi lần chạy đặt lock `backup-locks/<uuid>.json` vào bucket source, tạm dừng
  GC/cleanup account khi bản Worker mới chạy. Lock tự hết hạn sau 2 giờ nếu
  tiến trình bị ngắt. Lock có UUID riêng để các lượt chạy không ghi đè nhau.
- Các lệnh xóa project trực tiếp hoặc sự cố R2 trong lúc export/copy vẫn có thể
  làm backup thất bại; retry cả lượt. Chỉ tin backup có manifest và qua verify.
- Giới hạn hiện tại: metadata D1 export 64 MiB, mỗi object 50 MiB, 100.000 key,
  cửa sổ sao chép an toàn dưới 2 giờ. File lớn hơn bị từ chối rõ ràng.
- Backup chứa metadata D1 (có email và session đã băm), các snapshot Git và
  template được tham chiếu. Không bao gồm OAuth state tạm, object mồ côi hay
  draft Yjs chưa nằm trong snapshot. Chưa hỗ trợ backup Durable Objects.
- File tạm nằm trong thư mục riêng, được dọn trong `finally`; không đưa dữ liệu
  backup lên Git hoặc artifact của GitHub Actions, không in nội dung SQL/token.

### Verify và restore local

Lệnh create in ra `manifestKey` của bản hoàn tất. Dùng chính key đó:

```powershell
npm --prefix latex-editor-cloud run backup -- verify daily/THOI-GIAN_UUID/manifest.json
npm --prefix latex-editor-cloud run backup -- restore-local daily/THOI-GIAN_UUID/manifest.json D:/latex-editor/tmp/restore-moi
```

`restore-moi` phải chưa tồn tại và thư mục cha phải có sẵn. Lệnh tải và kiểm tra
checksum **tất cả file trước khi ghi local**, kiểm tra manifest trùng tập key
trong SQL, rồi khôi phục R2/D1 với `--local --persist-to` riêng. Không có chế độ
restore production trong script. Session được xóa khỏi bản D1 phục hồi để không
hồi sinh token đã revoke. Nếu restore local bị lỗi, giữ thư mục đó để kiểm tra;
chạy lại với một thư mục mới.

Khôi phục production là thao tác riêng: cần bảo trì dịch vụ, kiểm chứng backup,
khôi phục object trước metadata, thu hồi session và reset/đối chiếu room Yjs;
không import SQL vào production khi người dùng còn đang sửa.

### Lịch hằng ngày qua GitHub Actions

Workflow `.github/workflows/cloud-backup.yml` chạy lúc 19:20 UTC (02:20 sáng
Việt Nam), hoặc chạy thủ công. Các lượt được serialize bằng concurrency group.
Lịch chỉ hoạt động khi workflow có trên **default branch** của GitHub; push lên
`develop` chưa tự kích hoạt cron. Không có trigger deploy production khi push.

Trước khi bật:

1. Tạo API token riêng cho automation trong tài khoản Cloudflare đúng ở trên:
   quyền đọc/export D1 và quyền đọc/ghi R2 (bao gồm source lock và destination).
   Wrangler dùng Cloudflare REST API, vì vậy không dùng token chỉ dành cho S3.
   Giới hạn account đúng; nếu hệ thống token hỗ trợ giới hạn resource, giới hạn
   database và hai bucket tương ứng. Không dùng OAuth token cá nhân trong CI.
2. Lưu token trong repository Actions secret `CLOUD_BACKUP_API_TOKEN`.
   Không dán token vào chat, source code hay GitHub repository variable.
3. Thống nhất thời gian giữ backup; hiện **không có lifecycle tự xóa**.
4. Merge workflow vào default branch, đặt repository variable
   `CLOUD_BACKUP_ENABLED=true`, chạy thủ công và kiểm tra manifest/verify trước
   khi dựa vào lịch hằng ngày. Chưa có token hoặc variable thì lịch chưa bật.

Kiểm tra dịch vụ thật ngày 15/10/2026: bucket backup đã được tạo trong account
được cho phép, `r2.dev` bị tắt và không có custom domain. Snapshot hiện có 4
tham chiếu R2 nhưng 1 object trả `object not found`; đã sao chép được SQL và 3
object còn lại dưới nhãn `incomplete.json`. Cần xử lý tham chiếu bị thiếu trước
khi nghiệm thu backup đầy đủ hoặc bật lịch CI. Không tự sửa dữ liệu production
và không coi snapshot một phần là backup hoàn tất.

Backup private vẫn chiếm dung lượng và số thao tác R2; theo dõi dung lượng thực
tế. Workflow chỉ in tiến độ và metadata kỹ thuật, không upload artifact riêng tư.
Không tự tạo secret CI từ credential OAuth có sẵn trên máy cá nhân.

Tài liệu nền tảng:
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
