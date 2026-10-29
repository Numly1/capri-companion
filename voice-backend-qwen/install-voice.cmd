@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-voice.ps1" %*
if errorlevel 1 (
  echo Voice installation did not finish. Read README.ru.md and run this file again.
  pause
  exit /b 1
)
pause
