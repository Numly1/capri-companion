param([string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\.tools\capri-voice'))
$ErrorActionPreference = 'Stop'
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeDirectory)
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$uvPath = Join-Path $runtimePath 'bin\uv.exe'
$pythonPath = Join-Path $runtimePath 'venv\Scripts\python.exe'
$env:UV_CACHE_DIR = Join-Path $runtimePath 'uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimePath 'python-managed'
$env:UV_PYTHON_BIN_DIR = Join-Path $runtimePath 'bin'
$env:UV_NO_MODIFY_PATH = '1'
if (-not (Test-Path -LiteralPath $uvPath)) {
    $archivePath = Join-Path $runtimePath 'uv-0.13.6.zip'
    Invoke-WebRequest -Uri 'https://releases.astral.sh/github/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip' -OutFile $archivePath -UseBasicParsing
    $expectedHash = 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'uv archive checksum mismatch'
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath (Join-Path $runtimePath 'bin') -Force
}
if (-not (Test-Path -LiteralPath $pythonPath)) {
    & $uvPath python install 3.11.18 --no-bin --no-registry
    if ($LASTEXITCODE -ne 0) { throw 'Private Python installation failed' }
    $managedPython = & $uvPath python find --managed-python 3.11.18
    if ($LASTEXITCODE -ne 0) { throw 'Private Python was not found' }
    & $uvPath venv --python $managedPython (Join-Path $runtimePath 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Private environment creation failed' }
}
& $uvPath pip install --no-deps --python $pythonPath -r (Join-Path $PSScriptRoot 'requirements.lock')
if ($LASTEXITCODE -ne 0) { throw 'Voice dependency installation failed' }
& $uvPath pip check --python $pythonPath
if ($LASTEXITCODE -ne 0) { throw 'Voice dependencies are incompatible' }
& $pythonPath -c 'import inspect; from chatterbox.mtl_tts import ChatterboxMultilingualTTS as T; assert "t3_model" in inspect.signature(T.from_pretrained).parameters; print("Chatterbox V3 source is ready")'
if ($LASTEXITCODE -ne 0) { throw 'Installed engine does not support V3' }
Write-Host 'Voice engine installed. First launch will download the public model weights.'
