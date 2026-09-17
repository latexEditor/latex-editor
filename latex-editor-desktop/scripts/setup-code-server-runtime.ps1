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
Write-Host "Installing code-server $codeServerVersion..."
& (Join-Path $nodeHome 'npm.cmd') install --global --prefix $prefix "code-server@$codeServerVersion"
if ($LASTEXITCODE -ne 0) { throw "code-server installation failed with exit code $LASTEXITCODE" }

$entry = Join-Path $prefix 'node_modules\code-server\out\node\entry.js'
if (-not (Test-Path $entry)) { throw "Missing code-server entry point: $entry" }

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
Write-Host "Ready: $wrapper"
