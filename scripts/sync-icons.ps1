$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

Add-Type -AssemblyName System.Drawing

function New-Bitmap {
  param([int]$Size)
  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)
  return @{ Bitmap = $bitmap; Graphics = $graphics }
}

function New-Brush {
  param([string]$Hex)
  return New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($Hex))
}

function Add-RoundRect {
  param(
    [System.Drawing.Drawing2D.GraphicsPath]$Path,
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )
  $d = $Radius * 2
  $Path.AddArc($X, $Y, $d, $d, 180, 90)
  $Path.AddArc($X + $Width - $d, $Y, $d, $d, 270, 90)
  $Path.AddArc($X + $Width - $d, $Y + $Height - $d, $d, $d, 0, 90)
  $Path.AddArc($X, $Y + $Height - $d, $d, $d, 90, 90)
  $Path.CloseFigure()
}

function Fill-RoundRect {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Brush]$Brush,
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  try {
    Add-RoundRect $path $X $Y $Width $Height $Radius
    $Graphics.FillPath($Brush, $path)
  } finally {
    $path.Dispose()
  }
}

function Save-AppIcon {
  param([int]$Size, [string]$OutputPath)
  $surface = New-Bitmap $Size
  $g = $surface.Graphics
  try {
    $scale = $Size / 512.0
    $bg = New-Brush "#12151c"
    $bg2 = New-Brush "#222735"
    $cardShadow = New-Brush "#00000033"
    $cardBack = New-Brush "#6d5dfc"
    $cardMid = New-Brush "#20c997"
    $paper = New-Brush "#f7f8fb"
    $ink = New-Brush "#171a22"
    $muted = New-Brush "#9aa3b2"

    Fill-RoundRect $g $bg 0 0 $Size $Size (112 * $scale)
    Fill-RoundRect $g $bg2 (28 * $scale) (28 * $scale) (456 * $scale) (456 * $scale) (94 * $scale)

    Fill-RoundRect $g $cardShadow (155 * $scale) (150 * $scale) (220 * $scale) (270 * $scale) (34 * $scale)
    Fill-RoundRect $g $cardBack (132 * $scale) (118 * $scale) (212 * $scale) (260 * $scale) (32 * $scale)
    Fill-RoundRect $g $cardMid (158 * $scale) (144 * $scale) (212 * $scale) (260 * $scale) (32 * $scale)
    Fill-RoundRect $g $paper (184 * $scale) (98 * $scale) (212 * $scale) (276 * $scale) (34 * $scale)

    Fill-RoundRect $g $ink (227 * $scale) (70 * $scale) (126 * $scale) (64 * $scale) (30 * $scale)
    Fill-RoundRect $g $paper (254 * $scale) (88 * $scale) (72 * $scale) (28 * $scale) (14 * $scale)

    Fill-RoundRect $g $ink (224 * $scale) (180 * $scale) (124 * $scale) (18 * $scale) (9 * $scale)
    Fill-RoundRect $g $muted (224 * $scale) (232 * $scale) (128 * $scale) (16 * $scale) (8 * $scale)
    Fill-RoundRect $g $muted (224 * $scale) (282 * $scale) (92 * $scale) (16 * $scale) (8 * $scale)

    $surface.Bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $surface.Bitmap.Dispose()
  }
}

function Save-IcoFromPng {
  param([string]$PngPath, [string]$OutputPath)
  [byte[]]$png = [System.IO.File]::ReadAllBytes($PngPath)
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  try {
    $writer.Write([UInt16]0) # reserved
    $writer.Write([UInt16]1) # icon
    $writer.Write([UInt16]1) # image count
    $writer.Write([byte]0)   # 256px
    $writer.Write([byte]0)   # 256px
    $writer.Write([byte]0)   # color count
    $writer.Write([byte]0)   # reserved
    $writer.Write([UInt16]1) # planes
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$png.Length)
    $writer.Write([UInt32]22)
    $writer.Write($png)
    [System.IO.File]::WriteAllBytes($OutputPath, $stream.ToArray())
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

# macOS menu-bar icon: a TEMPLATE image (macOS keeps only the alpha channel and
# paints it in the menu bar's label colour), so it must be the clipboard glyph
# alone, black on transparent, with the clip slot and text lines cut out as
# holes. The full-colour app icon is an opaque rounded square and renders as a
# solid white box when used as a template. 16px + @2x, no padding.
function Save-TrayTemplate {
  param([int]$Size, [string]$OutputPath)
  $surface = New-Bitmap $Size
  $g = $surface.Graphics
  try {
    $s = $Size / 16.0
    $ink = New-Brush "#000000"
    $hole = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Transparent)
    # board
    Fill-RoundRect $g $ink (2 * $s) (1.5 * $s) (12 * $s) (13.5 * $s) (2.4 * $s)
    # clip on top
    Fill-RoundRect $g $ink (5 * $s) (0 * $s) (6 * $s) (3.6 * $s) (1.6 * $s)
    # holes: the clip slot + three text lines (cut through to transparent)
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    Fill-RoundRect $g $hole (6.6 * $s) (0.9 * $s) (2.8 * $s) (1.3 * $s) (0.6 * $s)
    Fill-RoundRect $g $hole (4.4 * $s) (6.3 * $s) (7.2 * $s) (1.4 * $s) (0.7 * $s)
    Fill-RoundRect $g $hole (4.4 * $s) (9.1 * $s) (7.2 * $s) (1.4 * $s) (0.7 * $s)
    Fill-RoundRect $g $hole (4.4 * $s) (11.9 * $s) (4.8 * $s) (1.4 * $s) (0.7 * $s)
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $surface.Bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $surface.Bitmap.Dispose()
  }
}

Save-AppIcon 512 (Join-Path $Root "assets\boardclip-icon.png")
Save-AppIcon 512 (Join-Path $Root "icon@2x.png")
Save-AppIcon 256 (Join-Path $Root "icon.png")
Save-AppIcon 256 (Join-Path $Root "site\favicon.png")
Save-IcoFromPng (Join-Path $Root "icon.png") (Join-Path $Root "assets\boardclip-icon.ico")
Save-TrayTemplate 16 (Join-Path $Root "iconTemplate.png")
Save-TrayTemplate 32 (Join-Path $Root "iconTemplate@2x.png")

Write-Host "Synced BoardClip app, installer, and site icons"
