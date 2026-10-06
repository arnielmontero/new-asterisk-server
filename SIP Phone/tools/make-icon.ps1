# Generates src\SipPhone\app.ico (a green handset on a rounded square) at 16/32/48/256 px, PNG-compressed.
# Run with Windows PowerShell:  powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)

    # rounded square, green gradient
    $r = [int]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
    $path.CloseFigure()
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 52, 190, 90)), ([System.Drawing.Color]::FromArgb(255, 24, 135, 62)), 90
    $g.FillPath($brush, $path)

    # handset: a thick arc with a round earpiece and mouthpiece at its ends
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single]($size * 0.13))
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $m = $size * 0.24
    $arcRect = New-Object System.Drawing.RectangleF ([single]($m)), ([single]($m)), ([single]($size - 2 * $m)), ([single]($size - 2 * $m))
    $g.DrawArc($pen, $arcRect, 100, 160)
    $cap = $size * 0.2
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.FillEllipse($white, [single]($size * 0.22), [single]($size * 0.62), [single]$cap, [single]($cap * 0.8))
    $g.FillEllipse($white, [single]($size * 0.58), [single]($size * 0.22), [single]($cap * 0.8), [single]$cap)
    $g.Dispose()
    return $bmp
}

$sizes = 16, 32, 48, 256
$images = foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [pscustomobject]@{ Size = $s; Bytes = $ms.ToArray() }
}

$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\SipPhone\app.ico'
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$img.Bytes.Length); $bw.Write([uint32]$offset)
    $offset += $img.Bytes.Length
}
foreach ($img in $images) { $bw.Write($img.Bytes) }
$bw.Close(); $fs.Close()
Write-Output "wrote $out"
