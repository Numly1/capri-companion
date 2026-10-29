param(
  [Parameter(Mandatory=$true)][string]$Owner,
  [string]$Repo='capri-companion',
  [string]$Tag='v0.4.4-companion.8',
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$IconPath=''
)
$ErrorActionPreference='Stop'
foreach ($capriIdentifier in @($Owner,$Repo,$Tag)) { if ($capriIdentifier -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid GitHub identifier.' } }
$capriManifest=Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ([long]$capriManifest.archiveBytes -ne 4199165651 -or [long]$capriManifest.unpackedBytes -ne 5722450647 -or $capriManifest.archiveSha256 -ne '6d95a7d8dc33965fd24e87d941643398b78491914a329ce14597924a799cb319' -or $capriManifest.launcherSha256 -ne '2a4caa05663701f81292525d4dfc99cea148eefed1b7da379414c351f1fdbf16') { throw 'Manifest does not describe the verified ready bundle.' }
$capriParts=@($capriManifest.parts)
if ($capriParts.Count -ne 3) { throw 'Exactly three parts are required.' }
if (@($capriParts.name | Sort-Object -Unique).Count -ne $capriParts.Count) { throw 'Part names must be unique.' }
$capriTotal=0L
$capriPartCode=@()
foreach ($capriPart in $capriParts) {
  if ($capriPart.name -notmatch '^capri-ready-win-x64\.zip\.part0[123]$' -or $capriPart.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or [long]$capriPart.bytes -le 0 -or [long]$capriPart.bytes -gt 1800000000) { throw 'Invalid part manifest.' }
  $capriTotal += [long]$capriPart.bytes
  $capriPartCode += ('new PartInfo("{0}",{1}L,"{2}")' -f $capriPart.name,$capriPart.bytes,$capriPart.sha256.ToLowerInvariant())
}
if ($capriTotal -ne 4199165651) { throw 'Archive size differs from the verified ready bundle.' }
$capriGenerated=@"
namespace CapriReadyDownload {
internal static class BuildInfo {
 internal const string Tag="$Tag";
 internal static readonly BundleSpec Bundle=new BundleSpec {
 BaseUri=new System.Uri("https://github.com/$Owner/$Repo/releases/download/$Tag/"),
 ArchiveBytes=4199165651L,
 ArchiveSha="6d95a7d8dc33965fd24e87d941643398b78491914a329ce14597924a799cb319",
 LauncherSha="2a4caa05663701f81292525d4dfc99cea148eefed1b7da379414c351f1fdbf16",
 Parts=new PartInfo[] { $($capriPartCode -join ',') }
 };
}}
"@
$capriGeneratedPath=Join-Path $PSScriptRoot 'BuildInfo.generated.cs'
[IO.File]::WriteAllText($capriGeneratedPath,$capriGenerated,[Text.UTF8Encoding]::new($false))
$capriCompiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $capriCompiler)) { throw 'The Windows .NET Framework compiler is unavailable.' }
$capriOutput=[IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($capriOutput)) -Force | Out-Null
$capriReferences=@('System.dll','System.Core.dll','System.Net.Http.dll','System.Drawing.dll','System.Windows.Forms.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll')
$capriArguments=@('/nologo','/target:winexe','/platform:anycpu','/optimize+',('/out:'+$capriOutput),('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest'))) + @($capriReferences | ForEach-Object { '/reference:'+$_ }) + @((Join-Path $PSScriptRoot 'DownloaderCore.cs'),(Join-Path $PSScriptRoot 'Program.cs'),(Join-Path $PSScriptRoot 'AssemblyInfo.cs'),$capriGeneratedPath)
$capriIcon=$null
if ($IconPath) {
  $capriIcon=(Resolve-Path -LiteralPath $IconPath).Path
} else {
  # Works both in the workspace .tools/github-publish/downloader and in public tools/downloader.
  $capriSearch=[IO.DirectoryInfo]::new($PSScriptRoot)
  for ($capriLevel=0; $capriLevel -lt 6 -and $capriSearch; $capriLevel++) {
    $capriCandidate=Join-Path $capriSearch.FullName 'app\assets\icons\capri.ico'
    if (Test-Path -LiteralPath $capriCandidate -PathType Leaf) { $capriIcon=(Resolve-Path -LiteralPath $capriCandidate).Path; break }
    $capriSearch=$capriSearch.Parent
  }
}
if ($capriIcon) { $capriArguments=@('/win32icon:'+$capriIcon)+$capriArguments }
& $capriCompiler @capriArguments
if ($LASTEXITCODE -ne 0) { throw 'Downloader compilation failed.' }
[pscustomobject]@{ok=$true;file=$capriOutput;bytes=(Get-Item -LiteralPath $capriOutput).Length;sha256=(Get-FileHash -LiteralPath $capriOutput -Algorithm SHA256).Hash;downloadBase="https://github.com/$Owner/$Repo/releases/download/$Tag/"} | ConvertTo-Json
