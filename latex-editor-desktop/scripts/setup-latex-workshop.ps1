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

# The upstream Build command only refreshes a PDF viewer that is already open.
# In this desktop product a manual Build should open/reuse the PDF tab on the
# right after a successful recipe, while auto-build on save stays unobtrusive.
$extensionDir = Get-ChildItem -LiteralPath $extensions -Directory -Filter 'james-yu.latex-workshop-10.4.0-*' |
  Sort-Object Name -Descending |
  Select-Object -First 1
if (-not $extensionDir) { throw 'Could not find the installed LaTeX Workshop extension.' }
$extensionMain = Join-Path $extensionDir.FullName 'out\src\main.js'
$extensionMainContents = Get-Content -Raw -LiteralPath $extensionMain
if ($extensionMainContents -notmatch 'const originalBuild = lw_1\.lw\.commands\.build;') {
  $buildHook = @'
function registerLatexWorkshopCommands(extensionContext) {
    const originalBuild = lw_1.lw.commands.build;
    lw_1.lw.commands.build = async (...args) => {
        let succeeded = false;
        const buildDone = lw_1.lw.event.on(lw_1.lw.event.BuildDone, () => { succeeded = true; });
        try {
            await originalBuild(...args);
            if (succeeded) {
                await lw_1.lw.commands.view('tab');
            }
        }
        finally {
            buildDone.dispose();
        }
    };
'@
  $extensionMainContents = $extensionMainContents.Replace('function registerLatexWorkshopCommands(extensionContext) {', $buildHook.TrimEnd())
  if ($extensionMainContents -notmatch 'const originalBuild = lw_1\.lw\.commands\.build;') {
    throw "Could not patch Build -> PDF behavior: $extensionMain"
  }
  $extensionMainContents | Set-Content -Encoding UTF8 -NoNewline -LiteralPath $extensionMain
}
Write-Host "LaTeX Workshop installed in $extensions"
