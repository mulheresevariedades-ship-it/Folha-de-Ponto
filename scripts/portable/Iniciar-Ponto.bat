@echo off
setlocal

rem ==========================================================================
rem  Folha de Ponto - Modo portatil
rem
rem  Sobe o sistema usando um banco de dados embutido (sem instalar Postgres).
rem  Basta executar este arquivo em qualquer computador da pasta.
rem
rem  As demais estacoes da rede NAO executam este arquivo: apenas abrem o
rem  navegador no endereco mostrado abaixo. Duas maquinas rodando este arquivo
rem  ao mesmo tempo sobre a mesma pasta causam perda de dados.
rem ==========================================================================

cd /d "%~dp0"

rem Pasta de dados padrao: subpasta "data" ao lado deste arquivo.
if "%PONTO_DATA_DIR%"=="" set "PONTO_DATA_DIR=%~dp0data"

if "%PORT%"=="" set "PORT=8080"

echo.
echo  Folha de Ponto - modo portatil
echo  Pasta de dados: %PONTO_DATA_DIR%
echo  Endereco:       http://localhost:%PORT%
echo.
echo  Para encerrar, feche esta janela ou pressione Ctrl+C.
echo.

rem Usa o runtime embutido, se presente; senao, o Node do sistema.
if exist "%~dp0runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
) else (
  set "NODE_EXE=node"
)

"%NODE_EXE%" "%~dp0server\portable.mjs"
set "EXIT_CODE=%ERRORLEVEL%"

rem Rede de seguranca: se o processo morrer de forma abrupta, remove a trava
rem para que a proxima abertura nao seja recusada.
if exist "%PONTO_DATA_DIR%\LOCK-PONTO.json" del /q "%PONTO_DATA_DIR%\LOCK-PONTO.json" 2>nul

if not "%EXIT_CODE%"=="0" (
  echo.
  echo  O sistema foi encerrado com erro (codigo %EXIT_CODE%).
  pause
)

endlocal
