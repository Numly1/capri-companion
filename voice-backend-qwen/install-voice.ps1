param([string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\.tools\capri-qwen-voice'))
$ErrorActionPreference = 'Stop'
$runtimePath = [IO.Path]::GetFullPath($RuntimeDirectory)
if ($runtimePath.TrimEnd('\') -eq [IO.Path]::GetPathRoot($runtimePath).TrimEnd('\')) { throw 'Choose a separate folder for the voice module.' }
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$uvPath = Join-Path $runtimePath 'bin\uv.exe'
$pythonPath = Join-Path $runtimePath 'venv\Scripts\python.exe'
$env:UV_CACHE_DIR = Join-Path $runtimePath 'uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimePath 'python-managed'
$env:UV_PYTHON_BIN_DIR = Join-Path $runtimePath 'bin'
$env:UV_NO_MODIFY_PATH = '1'
$env:HF_HOME = Join-Path $runtimePath 'hf-cache'
$env:TORCH_HOME = Join-Path $runtimePath 'torch-cache'
$env:NUMBA_CACHE_DIR = Join-Path $runtimePath 'numba-cache'
$env:XDG_CACHE_HOME = Join-Path $runtimePath 'cache'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
$env:HF_HUB_OFFLINE = '0'
$env:TRANSFORMERS_OFFLINE = '0'
$env:DO_NOT_TRACK = '1'
Write-Host 'Preparing the separate voice module. Please wait; several GB will be downloaded.'
if (-not (Test-Path -LiteralPath $uvPath -PathType Leaf)) {
    $archivePath = Join-Path $runtimePath 'uv-0.13.6.zip'
    Invoke-WebRequest -Uri 'https://releases.astral.sh/github/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip' -OutFile $archivePath -UseBasicParsing
    $expectedHash = 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Voice installer checksum mismatch.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath (Join-Path $runtimePath 'bin') -Force
}
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    & $uvPath python install 3.11.18 --no-bin --no-registry
    if ($LASTEXITCODE -ne 0) { throw 'Private Python installation failed.' }
    $managedPython = & $uvPath python find --managed-python 3.11.18
    if ($LASTEXITCODE -ne 0) { throw 'Private Python was not found.' }
    & $uvPath venv --python $managedPython (Join-Path $runtimePath 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Private voice environment creation failed.' }
}
& $uvPath pip install --no-deps --python $pythonPath -r (Join-Path $PSScriptRoot 'requirements.lock')
if ($LASTEXITCODE -ne 0) { throw 'Voice dependency installation failed.' }
& $uvPath pip check --python $pythonPath
if ($LASTEXITCODE -ne 0) { throw 'Voice dependencies are incompatible.' }
Write-Host 'Downloading the approved voice model. The next run can work offline.'
& $pythonPath (Join-Path $PSScriptRoot 'server.py') --runtime $runtimePath --device cpu --threads 2 --download-only
if ($LASTEXITCODE -ne 0) { throw 'Voice model download failed. Run the installer again to resume.' }
Write-Host 'Voice module is installed. Select the trial Capri voice in the app, or open start-voice.cmd.'
