Add-Type -AssemblyName System.Drawing

$srcPath = "d:\latex-editor\latex-editor-desktop\resources\icons\icon.png"
$icoPath = "d:\latex-editor\latex-editor-desktop\resources\icons\icon.ico"
$src = [System.Drawing.Image]::FromFile($srcPath)

$sizes = @(16, 32, 48, 64, 128, 256)
$images = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $bytes = $ms.ToArray()
    $ms.Dispose()

    $images += [PSCustomObject]@{
        Size = $size
        Bytes = $bytes
    }
}
$src.Dispose()

$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)

$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$images.Count)

$offset = 6 + ($images.Count * 16)

foreach ($img in $images) {
    $w = if ($img.Size -eq 256) { 0 } else { [byte]$img.Size }
    $h = if ($img.Size -eq 256) { 0 } else { [byte]$img.Size }
    $bw.Write([byte]$w)
    $bw.Write([byte]$h)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$img.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $img.Bytes.Length
}

foreach ($img in $images) {
    $bw.Write($img.Bytes)
}

$bw.Close()
$fs.Close()
Write-Host "Generated $icoPath with sizes: $($sizes -join ', ')"
