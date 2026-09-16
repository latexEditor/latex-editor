# Kế hoạch phát triển `latex-editor`

## 1. Mục tiêu hiện tại

Xây dựng một ứng dụng soạn thảo LaTeX trên desktop theo hướng:

```text
Electron shell
    ↓
code-server (giao diện VS Code nhúng trong ứng dụng)
    ↓
LaTeX Workshop
    ↓
Biên dịch .tex và xem PDF
```

Mục tiêu trước mắt là hoàn thành một MVP chạy hoàn toàn ở local. Người dùng có thể mở một dự án LaTeX, sửa file `.tex`, biên dịch và xem PDF ngay trong editor. Git, đồng bộ R2, đăng nhập và phiên bản web chỉ được thêm sau khi luồng local đã ổn định.

## 2. Hiện trạng

- Repo tham chiếu `reference-sync-data/electron-app` đã chạy được trên Windows.
- Môi trường đã dùng Node.js 20.19.5, phù hợp với phiên bản `code-server` hiện tại.
- Electron shell đã mở được màn hình đăng nhập.
- `main.js` của repo tham chiếu cho thấy kiến trúc chính:
  - `BrowserWindow` chứa giao diện shell của ứng dụng.
  - Một `WebContentsView` được đặt bên phải sidebar để nhúng `code-server`.
  - `CodeServerManager` chịu trách nhiệm chạy/dừng và kiểm tra trạng thái `code-server`.
  - `WorkspaceManager` chuẩn bị workspace và tạo URL mở workspace trong `code-server`.
  - `AuthManager` quản lý đăng nhập Google.
  - `GitSyncManager` và `AutoSyncService` thực hiện đồng bộ Git lên R2 sau khi có phiên đăng nhập hợp lệ.
- Repo tham chiếu có nhiều tính năng ngoài phạm vi MVP LaTeX như crawl website, chuyển tài liệu sang Markdown, chia sẻ mã hóa và recent files nâng cao.
- Chưa nên sao chép toàn bộ `main.js` của repo tham chiếu sang dự án mới. Chỉ nên lấy kiến trúc và tách từng thành phần cần thiết.

## 3. Phạm vi MVP đầu tiên

MVP phải làm được các việc sau:

1. Khởi động Electron.
2. Khởi động một tiến trình `code-server` local trên cổng trống.
3. Nhúng giao diện `code-server` vào cửa sổ Electron.
4. Mở một thư mục dự án LaTeX local.
5. Cài hoặc nạp sẵn LaTeX Workshop trong extension directory riêng của ứng dụng.
6. Nhận diện được bộ công cụ LaTeX, ưu tiên MiKTeX trên Windows hoặc TeX Live nếu được cấu hình.
7. Biên dịch `main.tex` thành PDF.
8. Xem PDF và đọc được log lỗi biên dịch.
9. Dừng sạch `code-server` và các tiến trình liên quan khi thoát ứng dụng.

Chưa đưa vào MVP:

- Bắt buộc đăng nhập trước khi mở editor.
- Đồng bộ Git/R2.
- Chia sẻ dự án.
- Phiên bản web.
- Crawl website hoặc chuyển Word/PDF sang Markdown.
- Collaboration thời gian thực.

## 4. Cấu trúc repo/local được đề xuất

```text
latex-editor/
├─ package.json
├─ package-lock.json
├─ README.md
├─ .gitignore
├─ docs/
│  ├─ architecture.md
│  └─ development.md
├─ scripts/
│  ├─ setup-code-server-runtime.ps1
│  ├─ setup-latex-workshop.ps1
│  └─ check-latex-runtime.ps1
├─ resources/
│  ├─ templates/
│  │  └─ basic-article/
│  │     ├─ main.tex
│  │     └─ README.md
│  └─ extensions/
├─ runtime/                         # sinh ra khi setup, không commit
│  ├─ code-server/
│  ├─ extensions/
│  └─ user-data/
├─ src/
│  ├─ main/
│  │  ├─ main.js                   # lifecycle Electron và phối hợp các manager
│  │  ├─ config.js                 # đường dẫn, port, môi trường
│  │  ├─ CodeServerManager.js      # start/stop/readiness của code-server
│  │  ├─ WorkspaceManager.js       # tạo, liệt kê, mở project local
│  │  ├─ LatexRuntimeManager.js    # phát hiện MiKTeX/TeX Live và kiểm tra compiler
│  │  └─ ipc.js                    # các IPC handler của shell
│  ├─ preload/
│  │  └─ preload.js                # API an toàn giữa renderer và main process
│  └─ renderer/
│     ├─ index.html
│     ├─ app.js
│     └─ styles.css
├─ test/
│  ├─ code-server-manager.test.js
│  ├─ workspace-manager.test.js
│  └─ latex-runtime-manager.test.js
└─ user-data/                       # dữ liệu dev local, không commit
   └─ projects/
      └─ <project-id>/
         ├─ main.tex
         ├─ assets/
         ├─ .vscode/
         │  └─ settings.json
         └─ .git/                   # chỉ có từ milestone Git trở đi
```

Nguyên tắc phân chia:

- `src/main/main.js` chỉ điều phối lifecycle, không chứa toàn bộ logic nghiệp vụ.
- Mỗi manager sở hữu một trách nhiệm rõ ràng và có thể kiểm thử riêng.
- `runtime/` chứa binary, extension và dữ liệu tạm do script tạo ra; không commit vào Git.
- Dự án của người dùng nằm ngoài source code ứng dụng khi đóng gói production. `user-data/projects` chỉ là vị trí minh họa cho môi trường phát triển.
- Renderer không gọi Node trực tiếp; giữ `nodeIntegration: false`, `contextIsolation: true` và dùng preload bridge có API tối thiểu.

## 5. Luồng kiến trúc đề xuất

### Khởi động MVP

```text
app.whenReady()
    ↓
khởi tạo cấu hình và manager
    ↓
createWindow()
    ↓
WorkspaceManager chọn/tạo workspace local
    ↓
CodeServerManager.start()
    ↓
CodeServerManager.waitUntilReady()
    ↓
tạo WebContentsView và load URL của code-server
    ↓
LaTeX Workshop mở workspace
```

### Bố cục cửa sổ

```text
┌──────────────────┬─────────────────────────────────────────┐
│ Electron sidebar │ WebContentsView                         │
│                  │                                         │
│ Projects         │ code-server / VS Code UI                │
│ New Project      │                                         │
│ Templates        │ LaTeX Workshop + PDF preview            │
│ Settings         │                                         │
└──────────────────┴─────────────────────────────────────────┘
```

Sidebar giai đoạn đầu chỉ cần `New Project`, `Open Project` và `Settings`. Không cần làm giao diện quản lý cloud trước.

## 6. Các file tham chiếu cần đọc trước

Đọc theo thứ tự dưới đây và ghi lại contract của từng class trước khi port code:

### 1. `src/main/main.js`

Tập trung vào:

- `app.whenReady()` và thứ tự khởi tạo manager.
- `createWindow()`.
- `openWorkspace()` và `closeWorkspace()`.
- Cách tạo, gắn và resize `WebContentsView`.
- Cách giới hạn navigation chỉ trong origin của `code-server`.
- Cách đăng ký IPC.
- Luồng shutdown và dọn tiến trình con.

### 2. `CodeServerManager.js`

Cần trả lời được:

- Binary/runtime của `code-server` nằm ở đâu?
- Lệnh và tham số nào được dùng để start?
- Cách chọn port trống?
- `extensions-dir` và `user-data-dir` được truyền thế nào?
- Cơ chế kiểm tra readiness và timeout?
- Cách thu log stdout/stderr?
- Cách stop tiến trình trên Windows và tránh process mồ côi?

### 3. `WorkspaceManager.js`

Cần làm rõ:

- Root workspace được xác định ở đâu?
- Cách tạo workspace/project mới?
- Có dùng `.code-workspace` không?
- URL `code-server` được tạo và encode thế nào?
- Quy tắc kiểm tra đường dẫn để ngăn mở nhầm thư mục ngoài phạm vi?
- Phần nào gắn với sync-data và phần nào dùng được cho local LaTeX?

### 4. `AuthManager.js`

Chỉ đọc để hiểu ranh giới tích hợp về sau:

- Google OAuth được mở và nhận callback như thế nào?
- Profile/token được lưu ở đâu?
- Session nào được main process giữ?
- `requireSignedIn()` đang chặn `openWorkspace()` ở đâu?
- Cần tách điều kiện đăng nhập thế nào để MVP local hoạt động không cần tài khoản?

Sau bốn file trên mới đọc `GitSyncManager.js` và `AutoSyncService.js`. Không cần đọc sâu nhóm share/crawler/document trong giai đoạn đầu.

## 7. Thành phần nên tái sử dụng từ `sync-data`

### Tái sử dụng ngay hoặc port có chọn lọc

- Cách tạo `BrowserWindow` an toàn.
- Mẫu dùng `WebContentsView` để nhúng `code-server`.
- Hàm layout/resize view theo chiều rộng sidebar.
- `CodeServerManager`: quy trình start, wait-until-ready, log và stop.
- Phần local của `WorkspaceManager`: đường dẫn workspace, `.code-workspace` và URL mở editor.
- Cơ chế cài extension vào extension directory riêng.
- Mẫu preload + IPC giữa Electron renderer và main process.
- `CodeServerCommandExecutor` nếu cần để sidebar gọi lệnh VS Code như mở project, build LaTeX hoặc mở PDF.
- Kiểm tra origin/navigation của view.
- Shutdown lifecycle bằng `Promise.allSettled` để dừng các service sạch sẽ.

### Tái sử dụng sau khi MVP local ổn định

- `AuthManager` và Google sign-in.
- `GitSyncManager`.
- `AutoSyncService`.
- Cấu hình/phiên R2.
- Recent projects hoặc recent files ở mức cần thiết.
- App badge hoặc trạng thái sync nếu giao diện cần.

### Tạm hoãn hoặc không đưa vào latex-editor nếu chưa có yêu cầu

- `WebsiteCrawler`.
- `WebsiteSessionManager`.
- `DocumentMarkdownManager`.
- `ShareManager`.
- `ShareCrypto`.
- `ShareBridgeManager`.
- Import cloud drive và cloud storage detector.
- Chia sẻ mã hóa, tải shared item và các protocol liên quan.
- Extension file history riêng của sync-data, trừ khi sản phẩm LaTeX thực sự cần.

## 8. Công việc cần làm ngay, theo thứ tự

### Bước 1 — Chốt baseline kỹ thuật

- Ghi lại các phiên bản đang chạy được: Node 20.19.5, npm, Electron và `code-server`.
- Kiểm tra repo `latex-editor` đã có `package.json` và Git hay chưa.
- Tạo `.nvmrc` hoặc trường `engines.node` để tránh quay lại Node 22 ngoài ý muốn.
- Xác nhận MiKTeX hoặc TeX Live đã cài và lệnh `pdflatex`/`latexmk` có trong PATH.

Kết quả cần có: một trang hướng dẫn setup máy mới có thể lặp lại.

### Bước 2 — Đọc và rút gọn kiến trúc tham chiếu

- Đọc bốn file ưu tiên ở mục 6.
- Vẽ dependency ngắn giữa `main.js`, workspace và code-server.
- Ghi rõ phần nào sao chép, phần nào viết lại và phần nào bỏ.
- Không port auth/R2 vào nhánh MVP.

Kết quả cần có: skeleton kiến trúc không phụ thuộc đăng nhập.

### Bước 3 — Tạo Electron shell tối thiểu

- Tạo `BrowserWindow` với cấu hình bảo mật.
- Tạo sidebar đơn giản.
- Tạo và resize `WebContentsView`.
- Đăng ký xử lý đóng app.

Kết quả cần có: Electron mở được shell và vùng editor trống ổn định.

### Bước 4 — Tích hợp code-server

- Port/rút gọn `CodeServerManager`.
- Dùng port động hoặc kiểm tra port trước khi start.
- Tách riêng `extensions-dir` và `user-data-dir` của ứng dụng.
- Hiển thị lỗi có ý nghĩa nếu server không ready.
- Chỉ cho `WebContentsView` điều hướng trong origin local đã tạo.

Kết quả cần có: Electron mở trực tiếp code-server mà không cần Google login.

### Bước 5 — Quản lý project LaTeX local

- Tạo `WorkspaceManager` phiên bản LaTeX.
- Hỗ trợ `New Project`, `Open Project` và template `basic-article`.
- Quy ước entry file mặc định là `main.tex`, nhưng không hard-code cho mọi dự án.
- Lưu danh sách project gần đây ở local settings.

Kết quả cần có: tạo và mở lại một dự án sau khi restart app.

### Bước 6 — Tích hợp LaTeX Workshop

- Cài/nạp sẵn extension `James-Yu.latex-workshop` vào extension directory của runtime.
- Thêm cấu hình workspace tối thiểu cho recipe dùng `latexmk` hoặc compiler đã chọn.
- Kiểm tra build, PDF preview, SyncTeX và log lỗi.
- Hiển thị hướng dẫn cài MiKTeX/TeX Live khi không phát hiện compiler.

Kết quả cần có: chỉnh `main.tex` → build → xem PDF thành công trong app.

### Bước 7 — Ổn định MVP

- Kiểm thử đường dẫn có dấu cách và tiếng Việt.
- Kiểm thử mở/đóng app nhiều lần không để lại process.
- Kiểm thử project có ảnh, bibliography và nhiều file `.tex`.
- Thêm logging phục vụ debug nhưng không ghi token hoặc dữ liệu nhạy cảm.
- Viết README chạy dự án và tiêu chí nghiệm thu.

Kết quả cần có: bản MVP local đủ ổn định để demo.

## 9. Kế hoạch milestone

### M0 — Hiểu repo tham chiếu và cố định môi trường

Phạm vi: đọc code, ghi dependency, khóa Node 20 và kiểm tra toolchain.

Hoàn thành khi:

- Giải thích được luồng Electron → workspace → code-server.
- Chạy lại repo tham chiếu từ môi trường sạch.
- Biết chính xác file/hàm sẽ port.

### M1 — Electron + code-server

Phạm vi: shell desktop, sidebar, `WebContentsView`, lifecycle và local workspace.

Hoàn thành khi:

- App mở thẳng editor local không cần tài khoản.
- Workspace được mở đúng.
- Resize hoạt động.
- Đóng app không để lại `code-server`.

### M2 — LaTeX Workshop MVP

Phạm vi: extension, LaTeX runtime, template, build và PDF preview.

Hoàn thành khi:

- Tạo project từ template.
- Build `main.tex` thành PDF.
- Xem PDF và lỗi compile trong editor.
- Hoạt động với đường dẫn Windows thực tế.

Đây là milestone demo đầu tiên và cần được hoàn thành trước mọi tính năng cloud.

### M3 — Git local

Phạm vi: khởi tạo Git cho từng project, commit cơ bản và lịch sử phiên bản.

Hoàn thành khi:

- Project mới có thể được `git init`.
- Có thể commit và phục hồi phiên bản theo UX đã chọn.
- Không làm mất file chưa commit.

### M4 — Auth + R2 sync

Phạm vi: Google login, profile, session R2, `GitSyncManager` và `AutoSyncService`.

Luồng dự kiến:

```text
Google login
    ↓
R2 session
    ↓
AutoSyncService
    ↓
GitSyncManager
    ↓
R2 (git-bundle-v1)
```

Hoàn thành khi:

- Local mode vẫn dùng được khi chưa đăng nhập hoặc mất mạng.
- Đăng nhập bật khả năng sync thay vì chặn editor.
- Push/pull có trạng thái rõ ràng và xử lý conflict an toàn.
- Kiểm tra protocol/version trước khi đồng bộ.
- Token và khóa không đi qua renderer ngoài API tối thiểu.

### M5 — Quản lý project cloud

Phạm vi: danh sách project, tạo/xóa/đổi tên, recent projects, sync status và khôi phục trên máy khác.

Hoàn thành khi:

- Đăng nhập trên máy khác tải được project và build lại được.
- Có trạng thái `local`, `syncing`, `synced`, `conflict`, `error`.
- Không ghi đè âm thầm khi hai máy cùng sửa.

### M6 — Phiên bản web

Chỉ bắt đầu sau khi định nghĩa rõ yêu cầu. Cần quyết định web là:

1. Web app kết nối backend chạy LaTeX trong container; hoặc
2. Remote code-server được quản lý theo người dùng; hoặc
3. Giao diện web riêng, không dùng Electron.

Các vấn đề phải thiết kế trước: sandbox compile, giới hạn CPU/RAM/thời gian, lưu trữ project, cô lập người dùng, hàng đợi build, preview PDF, auth và chi phí vận hành. Không nên coi Electron build là có thể chuyển thẳng lên web.

## 10. IPC dự kiến cho latex-editor

Chỉ thêm IPC khi sidebar thực sự cần gọi main process:

```text
latex:list-projects
latex:create-project
latex:create-from-template
latex:open-project
latex:rename-project
latex:delete-project
latex:get-runtime-status
latex:open-settings
```

Nếu LaTeX Workshop đã xử lý compile tốt thì chưa cần tự tạo `latex:compile-project`. Chỉ thêm lệnh này khi shell phải chủ động trigger build hoặc cần một build pipeline riêng ngoài extension.

## 11. Rủi ro cần kiểm soát

- Phiên bản Node và `code-server` không tương thích: khóa Node 20 cho baseline hiện tại.
- Electron binary hoặc native module chưa được cài đúng trên Windows: script setup phải kiểm tra trước và báo lỗi rõ.
- LaTeX distribution không có trong PATH: phát hiện runtime và chỉ dẫn người dùng.
- Extension Marketplace/VSIX thay đổi: pin phiên bản LaTeX Workshop đã kiểm thử.
- Process `code-server` bị treo sau khi đóng app: theo dõi child process và có shutdown timeout.
- Đường dẫn Windows có khoảng trắng/Unicode: không ghép command bằng chuỗi; truyền argument riêng và có test.
- Bê quá nhiều code từ sync-data: port theo contract, không kéo theo dependency cloud ngoài ý muốn.
- Auth chặn local editor: local-first; đăng nhập chỉ mở thêm tính năng cloud.
- Git conflict làm mất dữ liệu: luôn giữ working tree, tạo backup/recovery path và không force reset tự động.

## 12. Tiêu chí nghiệm thu MVP

- [ ] Cài dependency và runtime theo README trên một máy Windows sạch.
- [ ] Chạy Electron thành công bằng Node 20.
- [ ] Electron tự start và load `code-server`.
- [ ] Có sidebar tối thiểu và vùng editor resize đúng.
- [ ] Tạo được project từ template.
- [ ] Mở lại được project local có sẵn.
- [ ] LaTeX Workshop được nạp tự động.
- [ ] Phát hiện được MiKTeX hoặc TeX Live.
- [ ] Biên dịch `main.tex` thành PDF.
- [ ] Xem được PDF và log lỗi.
- [ ] Đường dẫn có dấu cách/tiếng Việt hoạt động.
- [ ] Đóng app không để lại process `code-server`.
- [ ] MVP không phụ thuộc Google login, Git hoặc R2.

## 13. Checklist ngắn để bắt đầu ngay

- [ ] Đọc `main.js` và ghi lại startup/open/shutdown flow.
- [ ] Đọc `CodeServerManager.js` và ghi command, port, runtime, readiness, stop.
- [ ] Đọc `WorkspaceManager.js` và ghi quy tắc path/workspace URL.
- [ ] Đọc `AuthManager.js` để xác định điểm cần tháo auth khỏi local MVP.
- [ ] Tạo skeleton repo theo cấu trúc đề xuất.
- [ ] Khóa Node 20 và pin các phiên bản runtime quan trọng.
- [ ] Chạy Electron shell tối thiểu.
- [ ] Nhúng code-server vào `WebContentsView`.
- [ ] Mở một workspace local không cần login.
- [ ] Cài LaTeX Workshop và kiểm tra LaTeX runtime.
- [ ] Build một project mẫu và xem PDF.
- [ ] Viết test/lifecycle cleanup trước khi bắt đầu Git/R2.

## 14. Quyết định kiến trúc quan trọng

Ưu tiên **local-first**:

```text
MVP local ổn định
    ↓
Git local
    ↓
Đăng nhập + R2 sync
    ↓
Quản lý project cloud
    ↓
Thiết kế web riêng
```

Thứ tự này giữ phần cốt lõi của sản phẩm có thể demo sớm, giảm số lớp phải debug cùng lúc và tránh để auth/cloud che khuất vấn đề chính: trải nghiệm soạn, biên dịch và xem LaTeX.
