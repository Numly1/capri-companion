# Read-only, local foreground classification and Spotify session metadata.
# Emits strict JSON every ten seconds. Never controls playback or reads window/document contents.
param([int]$ParentPid = 0, [switch]$Once, [switch]$WatchMedia)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class CapriCompanionForeground {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string[] Read() {
    var h=GetForegroundWindow(); uint id; GetWindowThreadProcessId(h,out id);
    string name=""; try { using(var p=Process.GetProcessById((int)id)) name=p.ProcessName; } catch {}
    var title=new StringBuilder(512); GetWindowText(h,title,title.Capacity);
    return new [] { name, title.ToString() };
  }
}
"@

$drawingApps = @{
  photoshop='Adobe Photoshop'; krita='Krita'; clipstudiopaint='CLIP STUDIO PAINT';
  sai='PaintTool SAI'; sai2='PaintTool SAI'; mspaint='Paint'; paintdotnet='Paint.NET';
  illustrator='Adobe Illustrator'; affinityphoto='Affinity Photo'; affinityphoto2='Affinity Photo';
  affinitydesigner='Affinity Designer'; affinitydesigner2='Affinity Designer'; medibangpaintpro='MediBang Paint';
  firealpaca='FireAlpaca'; firealpaca64='FireAlpaca'; blender='Blender'; ibispaint='ibisPaint'
}
function Get-DrawingApp {
  $foreground = [CapriCompanionForeground]::Read()
  $program = $foreground[0].ToLowerInvariant()
  if ($drawingApps.ContainsKey($program)) { return $drawingApps[$program] }
  if ($program -match '^(chrome|msedge|firefox|brave|opera|vivaldi)$') {
    if ($foreground[1] -match '\bPhotopea\b') { return 'Photopea' }
    if ($foreground[1] -match '\bFigma\b') { return 'Figma' }
  }
  return $null # No process name, raw title or filename is emitted.
}

$script:manager = $null
$script:asTask = $null
$script:mediaType = $null
$script:thumbnailCache = @{ key=''; cover=$null; at=[datetime]::MinValue }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Drawing
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $script:mediaType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
  $script:streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $script:streamSizeProperty = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime].GetProperty('Size')
  $script:streamReadMethod = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
  } | Select-Object -First 1
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
} catch {}

function Wait-WinRt($Operation, [Type]$ResultType) {
  if (-not $script:asTask) { return $null }
  $task = $script:asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait(3000)) { return $null }
  return $task.GetAwaiter().GetResult()
}

function Get-SpotifyCover($Properties, [string]$Key) {
  # One in-memory thumbnail, never a URL or a file. Retry absent art after thirty seconds.
  $age = ([datetime]::UtcNow - $script:thumbnailCache.at).TotalSeconds
  if ($script:thumbnailCache.key -ceq $Key -and $age -lt 30) { return $script:thumbnailCache.cover }
  $stream=$null; $input=$null; $memory=$null; $image=$null
  $bitmap=$null; $graphics=$null; $output=$null; $parameters=$null; $quality=$null
  $cover=$null
  try {
    if (-not $Properties.Thumbnail) { return $null }
    $stream = Wait-WinRt ($Properties.Thumbnail.OpenReadAsync()) $script:streamType
    # Bound compressed input before allocating or decoding.
    if (-not $stream) { return $null }
    # WinPS5 exposes this interface result as __ComObject. Reflection performs the
    # WinRT interface query; normal PowerShell member access silently returns null.
    $length = [long]$script:streamSizeProperty.GetValue($stream, $null)
    if ($length -lt 12 -or $length -gt 2097152) { return $null }
    $input = $script:streamReadMethod.Invoke($null, @($stream))
    $bytes = New-Object byte[] $length
    $offset=0
    while ($offset -lt $length) {
      $count = $input.Read($bytes, $offset, $length - $offset)
      if ($count -le 0) { return $null }
      $offset += $count
    }
    $memory = New-Object System.IO.MemoryStream(,$bytes)
    $image = [System.Drawing.Image]::FromStream($memory, $false, $true)
    if ($image.Width -lt 1 -or $image.Height -lt 1 -or $image.Width -gt 4096 -or $image.Height -gt 4096 -or ([long]$image.Width * $image.Height) -gt 8388608) { return $null }
    $scale = [Math]::Min(96.0 / $image.Width, 96.0 / $image.Height)
    $width = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.Clear([System.Drawing.Color]::Black)
    $graphics.DrawImage($image, 0, 0, $width, $height)
    $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $quality = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]75)
    $parameters.Param[0] = $quality
    $output = New-Object System.IO.MemoryStream
    $bitmap.Save($output, $encoder, $parameters)
    if ($output.Length -gt 24576) { return $null }
    $cover = 'data:image/jpeg;base64,' + [Convert]::ToBase64String($output.ToArray())
    return $cover
  } catch { return $null }
  finally {
    $script:thumbnailCache = @{ key=$Key; cover=$cover; at=[datetime]::UtcNow }
    foreach ($resource in @($quality,$parameters,$graphics,$bitmap,$image,$memory,$output,$input,$stream)) {
      if ($null -ne $resource) { try { $resource.Dispose() } catch { try { $resource.Close() } catch {} } }
    }
  }
}

function Get-Spotify {
  try {
    if (-not $script:manager -and $script:asTask) {
      $script:manager = Wait-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()) $managerType
    }
    if ($script:manager) {
      foreach ($session in $script:manager.GetSessions()) {
        if ($session.SourceAppUserModelId -notmatch '(?i)spotify') { continue }
        $properties = Wait-WinRt ($session.TryGetMediaPropertiesAsync()) $script:mediaType
        if (-not $properties -or [string]::IsNullOrWhiteSpace($properties.Title)) { continue }
        $duration=$null; $position=$null
        $playing = $session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'
        try {
          $timeline = $session.GetTimelineProperties()
          $duration = [Math]::Max(0, [Math]::Round(($timeline.EndTime - $timeline.StartTime).TotalMilliseconds))
          $positionNow = ($timeline.Position - $timeline.StartTime).TotalMilliseconds
          # Position is valid at LastUpdatedTime, not at the helper's poll time.
          if ($playing) { $positionNow += [Math]::Max(0, ([datetimeoffset]::UtcNow - $timeline.LastUpdatedTime).TotalMilliseconds) }
          $position = [Math]::Min($duration, [Math]::Max(0, [Math]::Round($positionNow)))
        } catch {}
        $key = [string]$properties.Artist + [char]0 + [string]$properties.Title + [char]0 + [string]$properties.AlbumTitle
        $cover = Get-SpotifyCover $properties $key
        return @{ title=[string]$properties.Title; artist=[string]$properties.Artist; album=[string]$properties.AlbumTitle;
          cover=$cover; durationMs=$duration; positionMs=$position;
          playing=$playing; source='gsmtc' }
      }
    }
  } catch { $script:manager = $null }
  # Older Spotify builds sometimes expose only a window title. Playback state cannot be proven.
  foreach ($spotify in @(Get-Process -Name Spotify -ErrorAction SilentlyContinue)) {
    $caption = $spotify.MainWindowTitle
    if ($caption -and $caption -notmatch '^(Spotify|Spotify Free|Spotify Premium)$' -and $caption -match '^(.+?)\s[-\u2013\u2014]\s(.+)$') {
      return @{ title=$Matches[2]; artist=$Matches[1]; playing=$null; source='window-title' }
    }
  }
  return $null
}

function Get-Watching {
  $foreground = [CapriCompanionForeground]::Read()
  if ($foreground[0] -notmatch '^(chrome|msedge|firefox|brave|opera|vivaldi|browser)$' -or $foreground[1] -notmatch '(?i)кинопоиск|kinopoisk') { return $null }
  $caption = $foreground[1] -replace '(?i)\s*[-–—|]\s*(?:Яндекс Браузер|Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera|Vivaldi).*$',''
  $caption = ($caption -replace '(?i)\s*[-–—|:]?\s*(?:Кинопоиск|Kinopoisk).*$','').Trim()
  if ($script:manager) {
    foreach ($session in $script:manager.GetSessions()) {
      if ($session.SourceAppUserModelId -notmatch '(?i)chrome|msedge|firefox|brave|opera|vivaldi|yandex|(?:^|[\\/.])browser(?:[\\/.]|$)') { continue }
      $properties = Wait-WinRt ($session.TryGetMediaPropertiesAsync()) $script:mediaType
      if (-not $properties -or [string]::IsNullOrWhiteSpace($properties.Title)) { continue }
      $title = [string]$properties.Title
      # Match the foreground page; another tab's media must not be attributed to Kinopoisk.
      if ($caption.Length -lt 3 -or ($title.IndexOf($caption,[StringComparison]::OrdinalIgnoreCase) -lt 0 -and $caption.IndexOf($title,[StringComparison]::OrdinalIgnoreCase) -lt 0)) { continue }
      return @{ service='Кинопоиск';title=$title.Substring(0,[Math]::Min(140,$title.Length));playing=($session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing');source='gsmtc' }
    }
  }
  if ($caption) { return @{ service='Кинопоиск';title=$caption.Substring(0,[Math]::Min(140,$caption.Length));playing=$null;source='window-title' } }
  return $null
}

do {
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  $app = $null
  $music = $null
  try { $app = Get-DrawingApp } catch {}
  try { $music = Get-Spotify } catch {}
  $snapshot = @{ drawingApp=$app; music=$music; mediaAvailable=($null -ne $script:manager) }
  if ($WatchMedia) { try { $snapshot.watching = Get-Watching } catch { $snapshot.watching=$null } }
  [Console]::Out.WriteLine(($snapshot | ConvertTo-Json -Depth 5 -Compress))
  [Console]::Out.Flush()
  if (-not $Once) { Start-Sleep -Seconds 10 }
} while (-not $Once)
