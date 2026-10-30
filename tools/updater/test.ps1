$ErrorActionPreference='Stop'
$capriCompiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$capriOutput=Join-Path $PSScriptRoot 'CapriUpdater.Tests.exe'
& $capriCompiler '/nologo' '/target:exe' '/platform:anycpu' ('/out:'+$capriOutput) ('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest')) '/reference:System.dll' '/reference:System.Core.dll' '/reference:System.Web.Extensions.dll' (Join-Path $PSScriptRoot 'UpdaterCore.cs') (Join-Path $PSScriptRoot 'CoreSelfTests.cs') (Join-Path $PSScriptRoot 'AssemblyInfo.cs')
if($LASTEXITCODE -ne 0){throw 'Updater test compilation failed.'}
& $capriOutput
if($LASTEXITCODE -ne 0){throw 'Updater core verification failed.'}
