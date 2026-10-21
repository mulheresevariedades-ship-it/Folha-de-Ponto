Param(
    [string]$Destino = "folha-digitalizada.png",
    [int]$Dpi = 200
)

# Gera a imagem de uma folha de ponto "escaneada" (usada nos testes de OCR).
# Requer Windows com System.Drawing (PowerShell 5.1+).

Add-Type -AssemblyName System.Drawing

$largura = [int](210 / 25.4 * $Dpi)   # A4 em pixels
$altura = [int](297 / 25.4 * $Dpi)
$margem = [int](20 / 25.4 * $Dpi)
$linha = [int](8 / 25.4 * $Dpi)

$bmp = New-Object System.Drawing.Bitmap $largura, $altura
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$titulo = New-Object System.Drawing.Font "Arial", ($linha * 1.1), ([System.Drawing.FontStyle]::Bold)
$normal = New-Object System.Drawing.Font "Arial", $linha
$pequeno = New-Object System.Drawing.Font "Arial", ($linha * 0.85)
$preto = [System.Drawing.Brushes]::Black
$cinza = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 40, 40, 40))

$g.DrawString("FOLHA DE PONTO", $titulo, $preto, $margem, $margem)
$g.DrawString("SECRETARIA DE ADMINISTRACAO", $pequeno, $cinza, $margem, ($margem + $linha * 1.6))
$g.DrawString("Competencia: 01/2027", $normal, $preto, $margem, ($margem + $linha * 3))
$g.DrawString("Servidor: Maria Silva Santos", $normal, $preto, $margem, ($margem + $linha * 4.4))
$g.DrawString("Matricula: 12345", $normal, $preto, $margem, ($margem + $linha * 5.8))
$g.DrawString("Periodo: 01/01/2027 a 31/01/2027", $normal, $preto, $margem, ($margem + $linha * 7.2))

# Grade de horarios, para simular a tabela da folha.
$topoTabela = $margem + $linha * 9
$colunas = @("Dia", "Entrada", "Saida", "Horas")
$colX = @($margem, ($margem + $linha * 4), ($margem + $linha * 9), ($margem + $linha * 13))
$linhaY = $topoTabela
$g.DrawString("DIA", $pequeno, $preto, $colX[0], $linhaY)
$g.DrawString("ENTRADA", $pequeno, $preto, $colX[1], $linhaY)
$g.DrawString("SAIDA", $pequeno, $preto, $colX[2], $linhaY)
$g.DrawString("HORAS", $pequeno, $preto, $colX[3], $linhaY)
$linhaY += $linha * 1.4
for ($dia = 1; $dia -le 31; $dia++) {
    $g.DrawString("0$dia", $pequeno, $preto, $colX[0], $linhaY)
    $g.DrawString("08:00", $pequeno, $preto, $colX[1], $linhaY)
    $g.DrawString("17:00", $pequeno, $preto, $colX[2], $linhaY)
    $g.DrawString("8,00", $pequeno, $preto, $colX[3], $linhaY)
    $linhaY += $linha * 1.15
}

$g.Dispose()
$bmp.Save($Destino, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "gerado: $Destino ($largura x $altura)"
