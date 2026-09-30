$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$nodeHome = Join-Path $runtime 'node20'
$prefix = Join-Path $runtime 'npm-global'
$wrapper = Join-Path $runtime 'code-server-node20.cmd'
$nodeVersion = '20.19.5'
$codeServerVersion = '4.93.1'
$archiveName = "node-v$nodeVersion-win-x64.zip"
$archive = Join-Path $runtime $archiveName
$expanded = Join-Path $runtime "node-v$nodeVersion-win-x64"

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (-not (Test-Path (Join-Path $nodeHome 'node.exe'))) {
  Write-Host "Downloading Node.js $nodeVersion runtime..."
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$nodeVersion/$archiveName" -OutFile $archive
  Expand-Archive -Force -Path $archive -DestinationPath $runtime
  if (Test-Path $nodeHome) { Remove-Item -Recurse -Force $nodeHome }
  Move-Item $expanded $nodeHome
  Remove-Item -Force $archive
}

$gitShellDirectories = @(
  (Join-Path $env:ProgramFiles 'Git\bin'),
  (Join-Path $env:ProgramFiles 'Git\usr\bin')
) | Where-Object { Test-Path (Join-Path $_ 'sh.exe') }
if ($gitShellDirectories.Count -eq 0 -and -not (Get-Command sh -ErrorAction SilentlyContinue)) {
  throw 'Git Bash is required by the code-server npm installer. Install Git for Windows, then run this command again.'
}
$shellPath = ($gitShellDirectories -join ';')
$env:PATH = "$nodeHome;$shellPath;$env:PATH"
$codeServerRoot = Join-Path $prefix 'node_modules\code-server'
$entry = Join-Path $codeServerRoot 'out\node\entry.js'
$codeServerPackage = Join-Path $codeServerRoot 'package.json'
$readyMarker = Join-Path $codeServerRoot '.latex-editor-runtime-ready'
$installedCodeServerVersion = if (Test-Path $codeServerPackage) {
  (Get-Content -Raw -LiteralPath $codeServerPackage | ConvertFrom-Json).version
} else { $null }
if ($installedCodeServerVersion -ne $codeServerVersion -or -not (Test-Path $entry) -or -not (Test-Path $readyMarker)) {
  if (Test-Path $codeServerRoot) {
    Write-Host 'Removing an incomplete code-server runtime...'
    Remove-Item -Recurse -Force $codeServerRoot
  }
  Write-Host "Installing code-server $codeServerVersion..."
  & (Join-Path $nodeHome 'npm.cmd') install --global --prefix $prefix "code-server@$codeServerVersion"
  if ($LASTEXITCODE -ne 0) { throw "code-server installation failed with exit code $LASTEXITCODE" }
} else {
  Write-Host "Using installed code-server $codeServerVersion."
}
if (-not (Test-Path $entry)) { throw "Missing code-server entry point: $entry" }

# VS Code 1.93 declares these packages with caret ranges. Reinstalling the old
# code-server package today can therefore pull their newer ESM-only releases,
# while this VS Code build still loads them through CommonJS. That crashes the
# Extension Host before extensions such as LaTeX Workshop can activate.
$vscodeRoot = Join-Path $prefix 'node_modules\code-server\lib\vscode'
$vscodeModules = Join-Path $vscodeRoot 'node_modules'
$deviceIdPackage = Join-Path $vscodeModules '@vscode\deviceid\package.json'
$deviceIdUuidPackage = Join-Path $vscodeModules '@vscode\deviceid\node_modules\uuid\package.json'
$ripgrepPackage = Join-Path $vscodeModules '@vscode\ripgrep\package.json'
$ripgrepBinary = Join-Path $vscodeModules '@vscode\ripgrep\bin\rg.exe'
$deviceIdVersion = if (Test-Path $deviceIdPackage) { (Get-Content -Raw -LiteralPath $deviceIdPackage | ConvertFrom-Json).version } else { $null }
$deviceIdUuidVersion = if (Test-Path $deviceIdUuidPackage) { (Get-Content -Raw -LiteralPath $deviceIdUuidPackage | ConvertFrom-Json).version } else { $null }
$ripgrepVersion = if (Test-Path $ripgrepPackage) { (Get-Content -Raw -LiteralPath $ripgrepPackage | ConvertFrom-Json).version } else { $null }
if ($deviceIdVersion -ne '0.1.1' -or $deviceIdUuidVersion -ne '9.0.1' -or $ripgrepVersion -ne '1.15.9' -or -not (Test-Path $ripgrepBinary)) {
  Write-Host 'Pinning VS Code 1.93-compatible runtime dependencies...'
  $compatRoot = Join-Path $runtime 'vscode-compat'
  if (Test-Path $compatRoot) { Remove-Item -Recurse -Force $compatRoot }
  New-Item -ItemType Directory -Force -Path $compatRoot | Out-Null
  & (Join-Path $nodeHome 'npm.cmd') install --prefix $compatRoot --omit=dev --no-save --package-lock=false '@vscode/deviceid@0.1.1' '@vscode/ripgrep@1.15.9'
  if ($LASTEXITCODE -ne 0) { throw "VS Code dependency pinning failed with exit code $LASTEXITCODE" }
  foreach ($packagePath in @('@vscode\deviceid', '@vscode\ripgrep')) {
    $source = Join-Path (Join-Path $compatRoot 'node_modules') $packagePath
    $target = Join-Path $vscodeModules $packagePath
    if (-not (Test-Path $source)) { throw "Missing staged compatibility package: $source" }
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Recurse -Force $source $target
  }
  $deviceIdModules = Join-Path $vscodeModules '@vscode\deviceid\node_modules'
  New-Item -ItemType Directory -Force -Path $deviceIdModules | Out-Null
  Copy-Item -Recurse -Force (Join-Path $compatRoot 'node_modules\uuid') (Join-Path $deviceIdModules 'uuid')
  Remove-Item -Recurse -Force $compatRoot
} else {
  Write-Host 'VS Code compatibility dependencies are already ready.'
}

# code-server 4.93.1 proxies extension-local HTTP servers through 0.0.0.0.
# Connecting to that wildcard address hangs on Windows, leaving embedded views
# such as LaTeX Workshop's PDF.js viewer blank. Use the loopback address.
$pathProxy = Join-Path $prefix 'node_modules\code-server\out\node\routes\pathProxy.js'
$pathProxyContents = Get-Content -Raw -LiteralPath $pathProxy
$patchedPathProxyContents = $pathProxyContents.Replace('http://0.0.0.0:${req.params.port}', 'http://127.0.0.1:${req.params.port}')
$patchedPathProxyContents = $patchedPathProxyContents.Replace('req.path.split(path.sep).slice(0, 3).join(path.sep)', 'req.path.split("/").slice(0, 3).join("/")')
$hasLoopbackPatch = $patchedPathProxyContents -match 'http://127\.0\.0\.1:\$\{req\.params\.port\}'
$hasUrlSeparatorPatch = $patchedPathProxyContents -notmatch 'req\.path\.split\(path\.sep\)'
if (-not $hasLoopbackPatch -or -not $hasUrlSeparatorPatch) {
  throw "Could not patch the code-server path proxy: $pathProxy"
}
$patchedPathProxyContents | Set-Content -Encoding UTF8 -NoNewline -LiteralPath $pathProxy
$wrapperContents = @"
@echo off
setlocal
set "PATH=$nodeHome;%PATH%"
"$nodeHome\node.exe" "$entry" %*
"@
$wrapperContents | Set-Content -Encoding ASCII -Path $wrapper
& $wrapper --version
if ($LASTEXITCODE -ne 0) { throw 'code-server verification failed.' }
Set-Content -Encoding ASCII -NoNewline -LiteralPath $readyMarker -Value "$codeServerVersion`n"
Write-Host "Ready: $wrapper"
