'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native WinPS5 turns a WinRT thumbnail into a bounded 96px JPEG and reuses its cache', { skip: process.platform !== 'win32' }, () => {
  const helper = path.join(__dirname, '../src/main/companion-media.ps1').replaceAll("'", "''");
  // Load the functions only, so the test reads no active application or music session.
  const script = `
$ErrorActionPreference='Stop'
$source = [IO.File]::ReadAllText('${helper}')
$source = $source.Substring(0, $source.IndexOf([char]10 + 'do {'))
Invoke-Expression $source
$bitmap = New-Object System.Drawing.Bitmap(320,240)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::Magenta)
$memory = New-Object System.IO.MemoryStream
$bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStreamReference,Windows.Storage.Streams,ContentType=WindowsRuntime]
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$writer = New-Object Windows.Storage.Streams.DataWriter($stream)
$writer.WriteBytes($memory.ToArray())
$null = Wait-WinRt ($writer.StoreAsync()) ([uint32])
$null = $writer.DetachStream()
$reference = [Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromStream($stream)
$cover = Get-SpotifyCover @{Thumbnail=$reference} 'test-only-artwork'
if (-not $cover) { throw 'WinRT thumbnail conversion returned no artwork' }
$bytes = [Convert]::FromBase64String($cover.Substring(23))
$decodedStream = New-Object System.IO.MemoryStream(,$bytes)
$decoded = [Drawing.Image]::FromStream($decodedStream)
# A different (invalid) source for the same track proves that the cached art is used.
$cached = Get-SpotifyCover @{Thumbnail=$null} 'test-only-artwork'
$result = @{ok=$true; jpeg=($bytes[0] -eq 255 -and $bytes[1] -eq 216); width=$decoded.Width; height=$decoded.Height; bytes=$bytes.Length; cached=($cached -ceq $cover)}
$decoded.Dispose(); $decodedStream.Dispose(); $writer.Dispose(); $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $memory.Dispose()
$result | ConvertTo-Json -Compress
`;
  const windowsPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8192 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const metadata = JSON.parse(result.stdout.trim());
  assert.equal(metadata.ok, true);
  assert.equal(metadata.jpeg, true);
  assert.equal(metadata.width, 96);
  assert.equal(metadata.height, 72);
  assert.ok(metadata.bytes > 100 && metadata.bytes <= 24576);
  assert.equal(metadata.cached, true);
});
