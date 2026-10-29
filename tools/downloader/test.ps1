$ErrorActionPreference='Stop'
$capriCompiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$capriOutput=Join-Path $PSScriptRoot 'CapriDownloader.Tests.exe'
$capriReferences=@('System.dll','System.Core.dll','System.Net.Http.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll')
& $capriCompiler '/nologo' '/target:exe' '/platform:anycpu' '/define:TEST_BUILD' ('/out:'+$capriOutput) ('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest')) @($capriReferences | ForEach-Object { '/reference:'+$_ }) (Join-Path $PSScriptRoot 'DownloaderCore.cs') (Join-Path $PSScriptRoot 'CoreSelfTests.cs') (Join-Path $PSScriptRoot 'AssemblyInfo.cs')
if ($LASTEXITCODE -ne 0) { throw 'Downloader test compilation failed.' }
& $capriOutput
if ($LASTEXITCODE -ne 0) { throw 'Downloader core verification failed.' }
