# One explicit local playback command. Only the selected native Spotify session is eligible.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Test-SpotifySessionId([string]$Value) {
  return $Value -match '^(?i:Spotify(?:\.exe)?|SpotifyAB\.SpotifyMusic_zpdnekdrzrea0!Spotify)$'
}

function Wait-SpotifyOperation($Operation, [Type]$ResultType) {
  $task = $script:spotifyAsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait(3000)) { throw 'timeout' }
  return $task.GetAwaiter().GetResult()
}

function Get-SpotifyControls($Session) {
  $info = $Session.GetPlaybackInfo()
  $playing = $null
  if ($info.PlaybackStatus.ToString() -eq 'Playing') { $playing = $true }
  elseif ($info.PlaybackStatus.ToString() -in @('Paused', 'Stopped')) { $playing = $false }
  return @{ playing=$playing; controls=@{ previous=($info.Controls.IsPreviousEnabled -eq $true); next=($info.Controls.IsNextEnabled -eq $true); play=($info.Controls.IsPlayEnabled -eq $true); pause=($info.Controls.IsPauseEnabled -eq $true) } }
}

function Invoke-SpotifyAction($Request, $Manager) {
  if (-not $Request -or $Request.action -notin @('previous','play','pause','next') -or -not (Test-SpotifySessionId $Request.sessionId)) { return @{ok=$false;code='invalid_request'} }
  $matches = @($Manager.GetSessions() | Where-Object { (Test-SpotifySessionId $_.SourceAppUserModelId) -and $_.SourceAppUserModelId -ieq $Request.sessionId })
  if ($matches.Count -ne 1) { return @{ok=$false;code='session_unavailable'} }
  $session = $matches[0]
  $before = Get-SpotifyControls $session
  if ($before.controls[$Request.action] -ne $true) { return @{ok=$false;code='not_supported'} }
  $operation = switch ($Request.action) {
    'previous' { $session.TrySkipPreviousAsync() }
    'play' { $session.TryPlayAsync() }
    'pause' { $session.TryPauseAsync() }
    'next' { $session.TrySkipNextAsync() }
  }
  $accepted = Wait-SpotifyOperation $operation ([bool])
  if ($accepted -ne $true) { return @{ok=$false;code='rejected'} }
  $after = Get-SpotifyControls $session
  return @{ok=$true;action=[string]$Request.action;playing=$after.playing;controls=$after.controls}
}

# Execute only when launched by the controller. Tests load the functions above with fake sessions.
try {
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 512) { throw 'invalid_request' }
  $request = $inputText | ConvertFrom-Json
  if (-not $request -or $request.action -notin @('previous','play','pause','next') -or -not (Test-SpotifySessionId $request.sessionId)) { throw 'invalid_request' }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $script:spotifyAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $manager = Wait-SpotifyOperation ($managerType::RequestAsync()) $managerType
  Invoke-SpotifyAction $request $manager | ConvertTo-Json -Depth 4 -Compress
} catch {
  $code = 'unavailable'
  if ($_.Exception.Message -eq 'timeout') { $code = 'timeout' }
  elseif ($_.Exception.Message -eq 'invalid_request') { $code = 'invalid_request' }
  @{ok=$false;code=$code} | ConvertTo-Json -Compress
}
