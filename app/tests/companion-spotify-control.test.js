'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createControl, sessionId } = require('../src/main/companion-spotify-control');
const script = require('../src/main/companion-spotify-control-script');

test('only native Spotify identities are eligible; browser and substring lookalikes fail closed', () => {
  for (const id of ['Spotify.exe', 'Spotify', 'spotify.exe', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify']) assert.equal(sessionId(id), id);
  for (const id of ['chrome.exe', 'Firefox Spotify', 'MySpotify.exe', 'spotify.exe.evil', 'C:\\Spotify.exe', 'SpotifyAB.SpotifyMusic_fake!Spotify', null, {}]) assert.equal(sessionId(id), null);
});

test('controller bounds commands, stays local, and sends only the explicit action and session on stdin', async () => {
  let calls = 0, sent, settings;
  const control = createControl({ platform: 'win32', execFile(exe, args, opts, done) {
    calls++; settings = { exe, args, opts };
    return { stdin: { on() {}, end(value) { sent = JSON.parse(value); done(null, JSON.stringify({ ok: true, playing: false, controls: { play: true, next: true, pause: 'yes', previous: true }, secret: 'not forwarded' })); } } };
  } });
  assert.equal((await control({ action: 'next', sessionId: 'chrome.exe' })).code, 'invalid_request');
  assert.equal((await control({ action: 'stop', sessionId: 'Spotify.exe' })).code, 'invalid_request');
  assert.equal((await control({ action: 'next', sessionId: 'Spotify.exe' }, { spotifyWidget: false })).code, 'disabled');
  assert.equal(calls, 0);
  const result = await control({ action: 'pause', sessionId: 'Spotify.exe', command: 'untrusted text', url: 'https://example.invalid' });
  assert.deepEqual(sent, { action: 'pause', sessionId: 'Spotify.exe' });
  assert.deepEqual(result, { ok: true, local: true, action: 'pause', playing: false, controls: { previous: true, play: true, pause: false, next: true } });
  assert.equal(settings.opts.windowsHide, true); assert.equal(settings.opts.maxBuffer, 8192); assert.equal(settings.opts.timeout, 12000);
  assert.ok(settings.args.includes('-EncodedCommand'));
  assert.equal(Buffer.from(settings.args.at(-1), 'base64').toString('utf16le'), script);
  assert.doesNotMatch(settings.args.join(' '), /untrusted text|example\.invalid/);
});

test('concurrent commands, helper failure, and unavailable Windows capability are reported without media-key fallback', async () => {
  let finish;
  const control = createControl({ platform: 'win32', execFile(exe, args, opts, done) { finish = done; return { stdin: { on() {}, end() {} } }; } });
  const pending = control({ action: 'next', sessionId: 'Spotify.exe' });
  assert.equal((await control({ action: 'previous', sessionId: 'Spotify.exe' })).code, 'busy');
  finish(null, '{"ok":false,"code":"session_unavailable","error":"private diagnostic"}');
  const failed = await pending; assert.equal(failed.code, 'session_unavailable'); assert.doesNotMatch(failed.error, /private/);
  const invalid = control({ action: 'next', sessionId: 'Spotify.exe' }); finish(null, '<not JSON>');
  assert.equal((await invalid).code, 'unavailable');
  assert.equal((await createControl({ platform: 'linux' })({ action: 'next', sessionId: 'Spotify.exe' })).code, 'unsupported');
});

test('packaged encoded helper exactly matches the BOM-protected PowerShell source', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/companion-spotify-control.ps1'));
  assert.deepEqual([...source.subarray(0, 3)], [239, 187, 191]);
  assert.equal(script.replace(/\r\n/g, '\n'), source.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
});

test('native WinPS dispatch checks the exact session and capabilities and never calls another app', { skip: process.platform !== 'win32' }, () => {
  const helper = path.join(__dirname, '../src/main/companion-spotify-control.ps1').replaceAll("'", "''");
  const ps = `
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText('${helper}')
Invoke-Expression $source.Substring(0,$source.IndexOf('# Execute only'))
function Wait-SpotifyOperation($Operation,[Type]$ResultType) { return $Operation }
$script:calls=New-Object System.Collections.Generic.List[string]
function Session([string]$id,[bool]$allow=$true,[bool]$accepted=$true) {
  $s=[pscustomobject]@{SourceAppUserModelId=$id;allowed=$allow;accepted=$accepted;playing=$true}
  $s | Add-Member ScriptMethod GetPlaybackInfo { return [pscustomobject]@{PlaybackStatus=$(if($this.playing){'Playing'}else{'Paused'});Controls=[pscustomobject]@{IsPreviousEnabled=$this.allowed;IsNextEnabled=$this.allowed;IsPlayEnabled=$this.allowed;IsPauseEnabled=$this.allowed}} }
  $s | Add-Member ScriptMethod TrySkipNextAsync { $script:calls.Add($this.SourceAppUserModelId+':next'); return $this.accepted }
  $s | Add-Member ScriptMethod TrySkipPreviousAsync { $script:calls.Add($this.SourceAppUserModelId+':previous'); return $this.accepted }
  $s | Add-Member ScriptMethod TryPauseAsync { $script:calls.Add($this.SourceAppUserModelId+':pause'); $this.playing=$false; return $this.accepted }
  $s | Add-Member ScriptMethod TryPlayAsync { $script:calls.Add($this.SourceAppUserModelId+':play'); $this.playing=$true; return $this.accepted }
  return $s
}
$manager=[pscustomobject]@{sessions=@((Session 'chrome.exe'),(Session 'MySpotify.exe'),(Session 'Spotify.exe'))}
$manager | Add-Member ScriptMethod GetSessions { return $this.sessions }
foreach($action in @('next','previous','pause','play')) { $r=Invoke-SpotifyAction @{action=$action;sessionId='Spotify.exe'} $manager; if(-not $r.ok) {throw $action} }
if($script:calls.Count -ne 4 -or @($script:calls | Where-Object {$_ -notlike 'Spotify.exe:*'}).Count) {throw 'another app received a command'}
$r=Invoke-SpotifyAction @{action='next';sessionId='chrome.exe'} $manager; if($r.code -ne 'invalid_request'){throw 'browser accepted'}
$manager.sessions=@((Session 'Spotify.exe' $false)); $r=Invoke-SpotifyAction @{action='next';sessionId='Spotify.exe'} $manager; if($r.code -ne 'not_supported'){throw 'disabled action called'}
$manager.sessions=@((Session 'Spotify.exe' $true $false)); $r=Invoke-SpotifyAction @{action='next';sessionId='Spotify.exe'} $manager; if($r.code -ne 'rejected'){throw 'native false was ignored'}
$manager.sessions=@((Session 'chrome.exe')); $r=Invoke-SpotifyAction @{action='next';sessionId='Spotify.exe'} $manager; if($r.code -ne 'session_unavailable'){throw 'wrong session fallback'}
$manager.sessions=@((Session 'Spotify.exe'),(Session 'Spotify.exe')); $r=Invoke-SpotifyAction @{action='next';sessionId='Spotify.exe'} $manager; if($r.code -ne 'session_unavailable'){throw 'ambiguous session accepted'}
@{ok=$true;commands=$script:calls.Count;otherAppsControlled=$false} | ConvertTo-Json -Compress
`;
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fixture = JSON.parse(result.stdout.trim()); assert.equal(fixture.ok, true); assert.equal(fixture.commands, 5); assert.equal(fixture.otherAppsControlled, false);
});
