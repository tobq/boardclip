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

function New-Pen {
  param([string]$Hex, [float]$Width)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($Hex)), $Width
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  return $pen
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

function Stroke-RoundRect {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Pen]$Pen,
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  try {
    Add-RoundRect $path $X $Y $Width $Height $Radius
    $Graphics.DrawPath($Pen, $path)
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

function Save-TrayIcon {
  param([int]$Size, [string]$OutputPath)
  $surface = New-Bitmap $Size
  $g = $surface.Graphics
  try {
    $scale = $Size / 32.0
    $white = New-Pen "#f4f7fb" (2.7 * $scale)
    $soft = New-Pen "#b9c2d0" (2.2 * $scale)

    Stroke-RoundRect $g $white (8 * $scale) (7 * $scale) (16 * $scale) (20 * $scale) (3 * $scale)
    $g.DrawLine($white, (12 * $scale), (12 * $scale), (20 * $scale), (12 * $scale))
    $g.DrawLine($soft, (12 * $scale), (17 * $scale), (20 * $scale), (17 * $scale))
    $g.DrawLine($soft, (12 * $scale), (22 * $scale), (18 * $scale), (22 * $scale))
    Stroke-RoundRect $g $white (11 * $scale) (4 * $scale) (10 * $scale) (6 * $scale) (3 * $scale)

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
Save-TrayIcon 32 (Join-Path $Root "assets\tray-icon.png")

Write-Host "Synced BoardClip app, tray, installer, and site icons"
