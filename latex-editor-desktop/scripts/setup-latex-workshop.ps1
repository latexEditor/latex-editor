$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $root 'runtime\code-server-node20.cmd'
if (-not (Test-Path $wrapper)) {
  throw 'code-server runtime is missing. Run npm run setup:code-server first.'
}
$dataRoot = if ($env:LATEX_EDITOR_DATA_DIR) { $env:LATEX_EDITOR_DATA_DIR } else { Join-Path $env:APPDATA 'LatexEditor' }
$userData = Join-Path $dataRoot 'code-server-data'
$extensions = Join-Path $dataRoot 'extensions'
New-Item -ItemType Directory -Force -Path $userData, $extensions | Out-Null

& $wrapper --user-data-dir $userData --extensions-dir $extensions --install-extension 'James-Yu.latex-workshop@10.4.0' --force
if ($LASTEXITCODE -ne 0) { throw 'LaTeX Workshop installation failed.' }
Write-Host "LaTeX Workshop installed in $extensions"
