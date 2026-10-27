param(
	[Parameter(Mandatory = $true)]
	[string]$InstallerPath,
	[Parameter(Mandatory = $true)]
	[string]$ZipPath
)

$ErrorActionPreference = "Stop"
$version = (Get-Content -LiteralPath "desktop/package.json" -Raw | ConvertFrom-Json).version
$testRoot = Join-Path $env:TEMP "ponto-digital-smoke-$([guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $testRoot "install"
$zipDir = Join-Path $testRoot "zip"
$profileDir = Join-Path $testRoot "profile"
$logsDir = Join-Path (Join-Path (Get-Location) "dist-installer") "smoke-logs"
New-Item -ItemType Directory -Path $installDir, $profileDir, $logsDir -Force | Out-Null

try {
	$installer = Start-Process -FilePath (Resolve-Path $InstallerPath) -ArgumentList @("/S", "/D=$installDir") -PassThru -Wait -WindowStyle Hidden
	if ($installer.ExitCode -ne 0) {
		throw "Instalador terminou com código $($installer.ExitCode)."
	}

	$appExe = Join-Path $installDir "Ponto Digital.exe"
	if (-not (Test-Path -LiteralPath $appExe)) {
		throw "Executável instalado não encontrado: $appExe"
	}
	Expand-Archive -LiteralPath (Resolve-Path $ZipPath) -DestinationPath $zipDir -Force
	$zipExe = Join-Path $zipDir "Ponto Digital.exe"
	if (-not (Test-Path -LiteralPath $zipExe)) {
		throw "Executável não encontrado no ZIP portátil: $zipExe"
	}

	$env:PONTO_DESKTOP_HOME = $profileDir
	$env:PONTO_DESKTOP_SMOKE_TEST = "1"
	$executables = @($appExe, $appExe, $zipExe)
	$labels = @("instalado 1", "instalado 2", "ZIP portátil")

	for ($attempt = 1; $attempt -le $executables.Count; $attempt++) {
		$logFile = Join-Path $profileDir "logs\launcher.log"
		Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
		$process = Start-Process -FilePath $executables[$attempt - 1] -PassThru
		$deadline = (Get-Date).AddSeconds(120)
		$healthOk = $false
		$uiOk = $false
		$port = $null

		while ((Get-Date) -lt $deadline) {
			if (Test-Path -LiteralPath $logFile) {
				$logText = Get-Content -LiteralPath $logFile -Raw
				if ($logText -match "Backend pronto na porta (\d+)") {
					$port = [int]$Matches[1]
					try {
						$health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/healthz" -TimeoutSec 2
						$healthOk = $health.status -eq "ok"
					} catch {
						$healthOk = $false
					}
				}
				if ($logText -match "Interface carregada; aplicação montada: 1\.") {
					$uiOk = $true
				}
				if ($logText -match "MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND") {
					throw "Erro de resolução de módulo no launcher.log:`n$logText"
				}
				if ($logText.Contains((Get-Location).Path)) {
					throw "O log do aplicativo contém um caminho absoluto do workspace.`n$logText"
				}
				if ($healthOk -and $uiOk) { break }
			}

		$process.Refresh()
		if ($process.HasExited -and -not ($healthOk -and $uiOk)) {
			$logText = if (Test-Path -LiteralPath $logFile) { Get-Content -LiteralPath $logFile -Raw } else { "launcher.log não foi criado." }
			throw "O aplicativo encerrou antes do healthcheck e da UI (código $($process.ExitCode)).`n$logText"
		}
		Start-Sleep -Milliseconds 500
		}

		if (-not $healthOk) { throw "Healthcheck não respondeu na execução $attempt." }
		if (-not $uiOk) { throw "A interface não montou o React root na execução $attempt." }
		if (-not (Test-Path -LiteralPath (Join-Path $profileDir "data\banco"))) {
			throw "Banco persistente não foi criado na execução $attempt."
		}

		$process.WaitForExit(30000) | Out-Null
		$process.Refresh()
		if (-not $process.HasExited) { throw "O aplicativo não encerrou de forma graciosa após o smoke test $attempt." }

		$logText = Get-Content -LiteralPath $logFile -Raw
		if ($logText -notmatch "Ponto Digital encerrado") {
			throw "O encerramento do aplicativo não foi registrado na execução $attempt.`n$logText"
		}
		$copy = Join-Path $logsDir "launcher-run-$attempt.log"
		Copy-Item -LiteralPath $logFile -Destination $copy -Force
		Write-Output "Execução $attempt/$($executables.Count) ($($labels[$attempt - 1])): healthcheck OK na porta $port, UI montada, dados presentes e encerramento gracioso. Log: $copy"
	}
}
finally {
	Remove-Item Env:PONTO_DESKTOP_SMOKE_TEST -ErrorAction SilentlyContinue
	Remove-Item Env:PONTO_DESKTOP_HOME -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}