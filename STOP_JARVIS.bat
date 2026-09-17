@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0windows-host\bin\JarvisVoiceHost.exe" (
  echo JARVIS Windows host is not installed or running.
  exit /b 0
)

"%~dp0windows-host\bin\JarvisVoiceHost.exe" --stop
echo JARVIS stop signal sent.
