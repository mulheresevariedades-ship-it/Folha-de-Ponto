<#
.SYNOPSIS
  Assina o instalador do Ponto Digital com um certificado .pfx.

.DESCRIPTION
  Usa Set-AuthenticodeSignature, nativo do Windows, portanto nao depende do
  signtool/Windows SDK. A senha pode vir de -Password ou da variavel de
  ambiente PONTO_SIGN_PASSWORD (recomendado: nao deixa a senha no historico).

  Um certificado autoassinado (ver new-test-cert.ps1) so sera aceito em
  maquinas onde o .cer correspondente estiver instalado como confiavel. Para
  distribuicao publica, use um certificado de autoridade certificadora.

.EXAMPLE
  $env:PONTO_SIGN_PASSWORD = "senha-do-pfx"
  .\scripts\desktop\sign-installer.ps1 -Pfx dist-installer\signing\Ponto-Digital-teste.pfx

.EXAMPLE
  .\scripts\desktop\sign-installer.ps1 -File dist-installer\Ponto-Digital-Setup-1.0.0.exe `
    -Pfx C:\certs\empresa.pfx -RequireValid
#>
[CmdletBinding()]
param(
	[string]$File,
	[Parameter(Mandatory = $true)][string]$Pfx,
	[string]$Password,
	[string]$TimestampServer = "http://timestamp.digicert.com",
	[switch]$RequireValid
)

$ErrorActionPreference = "Stop"

if (-not $File) {
	$File = Get-ChildItem (Join-Path $PSScriptRoot "..\..\dist-installer") -Filter "Ponto-Digital-Setup-*.exe" |
		Sort-Object LastWriteTime -Descending |
		Select-Object -First 1 -ExpandProperty FullName
}
if (-not $File -or -not (Test-Path $File)) { throw "Instalador nao encontrado. Informe -File." }
if (-not (Test-Path $Pfx)) { throw "Certificado nao encontrado: $Pfx" }

if (-not $Password) { $Password = $env:PONTO_SIGN_PASSWORD }
if (-not $Password) { throw "Informe -Password ou defina a variavel PONTO_SIGN_PASSWORD." }

$secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Pfx, $secure)
if (-not $cert.HasPrivateKey) { throw "O certificado de $Pfx nao tem chave privada." }

Write-Host "Arquivo: $File"
Write-Host "Certificado: $($cert.Subject)"
Write-Host "Thumbprint: $($cert.Thumbprint)"

try {
	Set-AuthenticodeSignature -FilePath $File -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampServer | Out-Null
	Write-Host "Assinado com carimbo de tempo: $TimestampServer"
} catch {
	Write-Warning "Falha no carimbo de tempo ($TimestampServer): $($_.Exception.Message)"
	Set-AuthenticodeSignature -FilePath $File -Certificate $cert -HashAlgorithm SHA256 | Out-Null
	Write-Warning "Assinado sem carimbo de tempo."
}

$result = Get-AuthenticodeSignature $File
Write-Host "Status: $($result.Status)"
if ($result.StatusMessage) { Write-Host "Detalhe: $($result.StatusMessage)" }
if (-not $result.SignerCertificate) { throw "A assinatura nao foi aplicada em $File." }
Write-Host "Assinado por: $($result.SignerCertificate.Subject)"
Write-Host "Thumbprint: $($result.SignerCertificate.Thumbprint)"
if ($result.TimeStamperCertificate) {
	Write-Host "Carimbo de tempo: $($result.TimeStamperCertificate.Subject)"
}
Write-Host "SHA256: $((Get-FileHash $File -Algorithm SHA256).Hash.ToLower())"

if ($RequireValid -and $result.Status -ne "Valid") {
	throw "Assinatura invalida: $($result.Status). Instale a cadeia do certificado ou use um certificado confiavel."
}
