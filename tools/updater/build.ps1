param(
  [Parameter(Mandatory=$true)][string]$AppExePath,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$IconPath=''
)
$ErrorActionPreference='Stop'
if($Version -notmatch '^[A-Za-z0-9_.-]{1,80}$'){throw 'Invalid version.'}
$capriPayload=(Resolve-Path -LiteralPath $AppExePath).Path
$capriPayloadInfo=Get-Item -LiteralPath $capriPayload
if($capriPayloadInfo.Length -lt 2 -or $capriPayloadInfo.Length -gt 512MB){throw 'Unexpected application size.'}
$capriInput=[IO.File]::OpenRead($capriPayload)
try{if($capriInput.ReadByte() -ne 77 -or $capriInput.ReadByte() -ne 90){throw 'Application must be a Windows EXE.'}}finally{$capriInput.Dispose()}
$capriSha=(Get-FileHash -LiteralPath $capriPayload -Algorithm SHA256).Hash.ToLowerInvariant()
$capriGenerated='namespace CapriReadyUpdate { internal static class BuildInfo { internal static readonly UpdateSpec Spec=new UpdateSpec { Version="'+$Version+'",Bytes='+$capriPayloadInfo.Length+'L,Sha256="'+$capriSha+'" }; } }'
$capriGeneratedPath=Join-Path $PSScriptRoot 'BuildInfo.generated.cs'
[IO.File]::WriteAllText($capriGeneratedPath,$capriGenerated,[Text.UTF8Encoding]::new($false))
$capriCompiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$capriOutput=[IO.Path]::GetFullPath($OutputPath)
if($capriOutput -eq $capriPayload){throw 'Updater output cannot overwrite its embedded application.'}
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($capriOutput)) -Force | Out-Null
$capriArgs=@('/nologo','/target:winexe','/platform:anycpu','/optimize+',('/out:'+$capriOutput),('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest')),('/resource:'+$capriPayload+',Capri.Application.exe'))+@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Drawing.dll','System.Windows.Forms.dll'|ForEach-Object{'/reference:'+$_})+@((Join-Path $PSScriptRoot 'UpdaterCore.cs'),(Join-Path $PSScriptRoot 'Program.cs'),(Join-Path $PSScriptRoot 'AssemblyInfo.cs'),$capriGeneratedPath)
if(-not $IconPath){$capriSearch=[IO.DirectoryInfo]::new($PSScriptRoot);for($capriLevel=0;$capriLevel -lt 6 -and $capriSearch;$capriLevel++){$capriCandidate=Join-Path $capriSearch.FullName 'app\assets\icons\capri.ico';if(Test-Path -LiteralPath $capriCandidate){$IconPath=$capriCandidate;break};$capriSearch=$capriSearch.Parent}}
if($IconPath){$capriArgs=@('/win32icon:'+(Resolve-Path -LiteralPath $IconPath).Path)+$capriArgs}
& $capriCompiler @capriArgs
if($LASTEXITCODE -ne 0){throw 'Updater compilation failed.'}
[pscustomobject]@{ok=$true;version=$Version;file=$capriOutput;bytes=(Get-Item -LiteralPath $capriOutput).Length;sha256=(Get-FileHash -LiteralPath $capriOutput -Algorithm SHA256).Hash.ToLowerInvariant();appBytes=$capriPayloadInfo.Length;appSha256=$capriSha;networkRequired=$false;voiceIncluded=$false}|ConvertTo-Json
