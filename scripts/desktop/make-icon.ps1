# Gera o ícone do Ponto Digital (assets/icon.png).
#
# O `icon.png` é a fonte do ícone: o electron-builder converte a partir dele o
# .ico multi-tamanho usado no executável, nos atalhos e no instalador NSIS.
# Se você tiver um logo oficial, substitua este desenho por ele (PNG quadrado,
# no mínimo 256x256) e rode de novo `pnpm build:installer`.
#
# Uso: powershell -ExecutionPolicy Bypass -File scripts/desktop/make-icon.ps1

Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$assets = Join-Path $repo "assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

$size = 512
$brand = [System.Drawing.Color]::FromArgb(255, 255, 60, 0)
$white = [System.Drawing.Color]::White

$bitmap = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Fundo: quadrado arredondado na cor da marca.
$radius = 112
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush($brand)
$g.FillPath($brush, $path)

# Relógio: anel branco com ponteiros arredondados (marca de "ponto").
$ringPen = New-Object System.Drawing.Pen($white, 42)
$ringPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$ringPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawEllipse($ringPen, 106, 106, 300, 300)

$handPen = New-Object System.Drawing.Pen($white, 34)
$handPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$handPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$centerX = 256
$centerY = 256
# Ponteiro das horas (~10h) e dos minutos (~2h).
$g.DrawLine($handPen, $centerX, $centerY, 186, 196)
$g.DrawLine($handPen, $centerX, $centerY, $centerX + 62, $centerY - 96)

$dotBrush = New-Object System.Drawing.SolidBrush($white)
$g.FillEllipse($dotBrush, $centerX - 22, $centerY - 22, 44, 44)

$g.Dispose()
$bitmap.Save((Join-Path $assets "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "Icone gerado em assets/icon.png (512x512)."
