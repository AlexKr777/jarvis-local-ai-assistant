@echo off
setlocal
cd /d "%~dp0"
rem Rank the live feed by Binance's positive 24-hour top ten.  Score remains diagnostic only.
set "JARVIS_CRYPTO_TOP_RUNNER_MODE=1"
set "JARVIS_CRYPTO_REQUIRE_SCORE_FOR_LIVE_RUNNER=0"
set "JARVIS_CRYPTO_COMPETITION_WINDOW_MS=0"
set "JARVIS_CRYPTO_DEEP_ANALYSIS_QUEUE_LIMIT=1"
set "JARVIS_CRYPTO_DEEP_ANALYSIS_PER_SYMBOL_COOLDOWN_MS=60000"

where node >nul 2>nul || goto :missing_node
where codex >nul 2>nul || goto :missing_codex

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-parser.ps1"
if errorlevel 1 (
  echo JARVIS Parser dependencies could not be prepared.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows-host.ps1"
if errorlevel 1 (
  echo JARVIS Windows host could not be built.
  pause
  exit /b 1
)

start "" "%~dp0windows-host\bin\JarvisVoiceHost.exe"
exit /b 0

:missing_node
echo Node.js 22 or newer was not found. Install Node.js and run this file again.
pause
exit /b 1

:missing_codex
echo Codex CLI was not found. Install or update Codex, then run this file again.
pause
exit /b 1
