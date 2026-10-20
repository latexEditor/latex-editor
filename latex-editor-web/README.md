# LaTeX Editor Web

Web client local-first cho LaTeX Editor. Bản này triển khai giao diện soạn thảo riêng cho trình duyệt theo định hướng M9; không nhúng Electron hoặc `code-server`.

## Chạy local

```powershell
npm run web:dev
```

Mở `http://127.0.0.1:4173`. Build và kiểm thử:

```powershell
npm run web:test
npm run web:build
```

## Phạm vi hiện tại

- Project và nhiều tệp được lưu local-first trong `localStorage`.
- Tạo project từ bốn template, autosave, đổi project, tạo file và xuất project JSON.
- Trình soạn thảo có line number, tab indentation, outline, phím tắt lưu/biên dịch.
- Bản xem nhanh cục bộ đọc metadata và cấu trúc LaTeX; đây không phải PDF compiler.
- `LatexEditorApi` đã tách lớp kết nối health/compile để nối backend sau này.
- Giao diện responsive và có light/dark mode.

## Kiến trúc web cần hoàn thiện trước production

Backend hiện tại dùng OAuth loopback + Bearer token và Git bundle cho desktop. Web production cần thêm luồng browser session bằng cookie `HttpOnly; Secure; SameSite`, CSRF, CORS allowlist và endpoint `/v1/compile` chạy trong sandbox có giới hạn CPU/RAM/thời gian. Không lưu token desktop trong `localStorage`.

Đề xuất compiler nhận `{ files, entry }`, giới hạn kích thước/số file, từ chối path traversal và shell escape, chạy TeX trong isolate/container dùng một lần, rồi trả PDF hoặc structured build log. Dữ liệu browser hiện tại có thể chuyển từ `localStorage` sang IndexedDB/OPFS khi thêm binary assets và project lớn.
