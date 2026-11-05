'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the native foreground watcher uses the pure game classifier before and after process-path lookup', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/windows.ps1'), 'utf8');
  const program = source.slice(source.indexOf('static void Program('), source.indexOf('// Verify the client process'));
  assert.match(program, /game = GameForProgram\(proc, null\);/);
  assert.match(program, /game = GameForProgram\(proc, path\.ToString\(\)\);/);
  assert.ok(program.indexOf('GameForProgram(proc, null)') < program.indexOf('OpenProcess('), 'Riot identity survives inaccessible executable paths');
  assert.doesNotMatch(program, /GAME\.Match|GetWindowText/);
});

test('actual native C# excludes Steam Krita without changing real games, launchers or exact Riot priority', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(__dirname, '../src/main/windows.ps1').replaceAll("'", "''");
  const ps = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$source=[IO.File]::ReadAllText('${file}')
Invoke-Expression $source.Substring(0,$source.IndexOf('[CapriWindows]::Init()'))
@{
  steamKrita=[CapriWindows]::GameForProgram('krita','D:\\SteamLibrary\\steamapps\\common\\Krita\\bin\\krita.exe')
  steamKritaExtension=[CapriWindows]::GameForProgram('KRITA.EXE','D:\\SteamLibrary\\steamapps\\common\\Krita\\bin\\krita.exe')
  portableKrita=[CapriWindows]::GameForProgram('krita','D:\\Art\\krita.exe')
  noKritaPath=[CapriWindows]::GameForProgram('krita',$null)
  lookalike=[CapriWindows]::GameForProgram('fake-krita','D:\\SteamLibrary\\steamapps\\common\\ARealGame\\fake-krita.exe')
  folderOnly=[CapriWindows]::GameForProgram('game','D:\\SteamLibrary\\steamapps\\common\\Krita\\game.exe')
  steamGame=[CapriWindows]::GameForProgram('Terraria','D:\\SteamLibrary\\steamapps\\common\\Terraria\\Terraria.exe')
  steamLauncher=[CapriWindows]::GameForProgram('launcher','D:\\SteamLibrary\\steamapps\\common\\GameLauncher\\launcher.exe')
  steamworks=[CapriWindows]::GameForProgram('helper','D:\\SteamLibrary\\steamapps\\common\\Steamworks Shared\\helper.exe')
  epicGame=[CapriWindows]::GameForProgram('FortniteClient-Win64-Shipping','D:\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe')
  valorant=[CapriWindows]::GameForProgram('VALORANT-Win64-Shipping','D:\\SteamLibrary\\steamapps\\common\\AnotherFolder\\VALORANT-Win64-Shipping.exe')
  valorantNoPath=[CapriWindows]::GameForProgram('VALORANT-Win64-Shipping',$null)
  lol=[CapriWindows]::GameForProgram('League of Legends','D:\\Riot Games\\SomeFolder\\Game\\League of Legends.exe')
  lolNoPath=[CapriWindows]::GameForProgram('League of Legends.exe',$null)
  riotLauncher=[CapriWindows]::GameForProgram('RiotClientServices','D:\\Riot Games\\Riot Client\\RiotClientServices.exe')
  ss14=[CapriWindows]::GameForProgram('Robust.Client','D:\\SteamLibrary\\steamapps\\common\\Space Station 14\\Robust.Client.exe')
  minecraft=[CapriWindows]::GameForProgram('javaw','D:\\Java\\bin\\javaw.exe')
  empty=[CapriWindows]::GameForProgram($null,$null)
} | ConvertTo-Json -Compress`;
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    steamKrita: '', steamKritaExtension: '', portableKrita: '', noKritaPath: '',
    lookalike: 'ARealGame', folderOnly: 'Krita', steamGame: 'Terraria', steamLauncher: '', steamworks: '',
    epicGame: 'Fortnite', valorant: 'Valorant', valorantNoPath: 'Valorant', lol: 'League of Legends', lolNoPath: 'League of Legends', riotLauncher: '',
    ss14: 'Space Station 14', minecraft: '', empty: '',
  });
});
