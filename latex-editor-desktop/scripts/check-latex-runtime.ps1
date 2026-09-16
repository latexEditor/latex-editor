$ErrorActionPreference = 'Stop'

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
