$ErrorActionPreference = 'Stop'

$candidateDirs = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\MiKTeX\miktex\bin\x64'),
  (Join-Path $env:ProgramFiles 'MiKTeX\miktex\bin\x64'),
  (Join-Path $env:ProgramFiles 'texlive\2026\bin\windows'),
  (Join-Path $env:ProgramFiles 'texlive\2025\bin\windows')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

# Keep this check consistent with the desktop app: a normal MiKTeX/TeX Live
# installation is usable even when the terminal that launched npm has a stale PATH.
foreach ($directory in $candidateDirs) {
  $pathEntries = @($env:PATH -split ';')
  if (-not ($pathEntries | Where-Object { $_.TrimEnd('\') -ieq $directory.TrimEnd('\') })) {
    $env:PATH = "$directory;$env:PATH"
  }
}

$tools = @('latexmk', 'pdflatex', 'xelatex')
$found = @()
foreach ($tool in $tools) {
  $command = Get-Command $tool -ErrorAction SilentlyContinue
  if ($command) {
    Write-Host "[OK] $tool -> $($command.Source)"
    $found += $tool
  } else {
    Write-Host "[--] $tool was not found in PATH"
  }
}
if (($found -notcontains 'latexmk') -and ($found -notcontains 'pdflatex')) {
  Write-Warning 'No supported LaTeX compiler was found. Install MiKTeX or TeX Live and enable its PATH option.'
  exit 2
}
Write-Host 'LaTeX build toolchain is ready.'
