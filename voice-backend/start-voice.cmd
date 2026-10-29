@echo off
setlocal
set "CAPRI_VOICE_PYTHON=%~dp0..\.tools\capri-voice\venv\Scripts\python.exe"
if not exist "%CAPRI_VOICE_PYTHON%" (
  echo Local voice runtime is not installed. Read README.ru.md.
  pause
  exit /b 1
)
"%CAPRI_VOICE_PYTHON%" "%~dp0server.py" --device cpu --threads 2 --warmup %*
pause
