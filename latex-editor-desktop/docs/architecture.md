# Kiến trúc MVP

```text
Electron main process
├─ WorkspaceManager     project, template, recent list
├─ LatexRuntimeManager  phát hiện latexmk/pdflatex/xelatex
├─ CodeServerManager    port, start, readiness, logs, shutdown
├─ IPC                  API tối thiểu cho topbar
└─ WebContentsView      code-server + LaTeX Workshop
```

Renderer của topbar chạy với `nodeIntegration: false`, `contextIsolation: true` và `sandbox: true`. Nó chỉ nhận API đã liệt kê trong preload. Trang code-server nằm trong một `WebContentsView` riêng, chiếm toàn bộ vùng dưới topbar; điều hướng bị giới hạn vào đúng local origin đã khởi tạo. Vì không có sidebar Electron nên Activity Bar và Explorer của VS Code là thanh điều hướng duy nhất.

Project người dùng nằm trong `%APPDATA%\LatexEditor\projects` theo mặc định. code-server user data và extensions cũng nằm dưới `%APPDATA%\LatexEditor`, không nằm trong source tree.

Auth, Git, R2, sharing và web app không thuộc dependency graph của MVP.
