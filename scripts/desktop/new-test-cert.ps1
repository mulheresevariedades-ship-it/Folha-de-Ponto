<#
.SYNOPSIS
  Cria um certificado de code signing autoassinado, somente para testes.

.DESCRIPTION
  Este certificado NAO serve para distribuir o Ponto Digital: nao foi emitido
  por uma autoridade certificadora e so sera aceito nas maquinas em que o .cer
  gerado for instalado manualmente como confiavel (Autoridades de Certificacao
  Raiz Confiaveis e Editores Confiaveis).

  Gera o .pfx (com senha) e o .cer (chave publica) em dist-installer\signing,
  que e ignorado pelo git. O certificado tambem fica em Cert:\CurrentUser\My.

.EXAMPLE
  $env:PONTO_SIGN_PASSWORD = "senha-do-pfx"
  .\scripts\desktop\new-test-cert.ps1
#>
[CmdletBinding()]
param(
	[string]$Password,
	[string]$Subject = "CN=Ponto Digital (teste interno), O=DIGEP - Universidade Federal, C=BR",
	[string]$OutDir = (Join-Path $PSScriptRoot "..\..\dist-installer\signing"),
	[int]$Years = 2
)

$ErrorActionPreference = "Stop"

if (-not $Password) { $Password = $env:PONTO_SIGN_PASSWORD }
if (-not $Password) { throw "Informe -Password ou defina a variavel PONTO_SIGN_PASSWORD." }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cert = New-SelfSignedCertificate `
	-Type CodeSigningCert `
	-Subject $Subject `
	-FriendlyName "Ponto Digital - teste interno" `
	-CertStoreLocation Cert:\CurrentUser\My `
	-KeyExportPolicy Exportable `
	-KeyUsage DigitalSignature `
	-KeyLength 3072 `
	-HashAlgorithm SHA256 `
	-NotAfter (Get-Date).AddYears($Years)

$secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
$pfx = Join-Path $OutDir "Ponto-Digital-teste.pfx"
$cer = Join-Path $OutDir "Ponto-Digital-teste.cer"
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null

Write-Host "Certificado: $($cert.Subject)"
Write-Host "Thumbprint: $($cert.Thumbprint)"
Write-Host "Validade: $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "PFX (guardar em segredo): $pfx"
Write-Host "CER (distribuir para confiar): $cer"
Write-Warning "Certificado de teste: nao use para distribuir o sistema."
