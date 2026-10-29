param([string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\.tools\capri-qwen-voice'))
$ErrorActionPreference = 'Stop'
$runtimePath = [IO.Path]::GetFullPath($RuntimeDirectory)
$pythonPath = Join-Path $runtimePath 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) { throw 'Voice module is not installed. Open install-voice.cmd first.' }
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
$env:DO_NOT_TRACK = '1'
& $pythonPath (Join-Path $PSScriptRoot 'server.py') --runtime $runtimePath --device cpu --threads 2 --offline
exit $LASTEXITCODE
