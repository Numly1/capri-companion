'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const script = require('./companion-spotify-control-script');

const SESSION_ID = /^(?:Spotify(?:\.exe)?|SpotifyAB\.SpotifyMusic_zpdnekdrzrea0!Spotify)$/i;
const ACTIONS = ['previous', 'play', 'pause', 'next'];
const ERRORS = {
  invalid_request: 'Не удалось выбрать команду Spotify.', disabled: 'Сначала включи карточку Spotify в меню Капри.',
  session_unavailable: 'Сессия Spotify недоступна. Открой приложение Spotify и включи трек.',
  not_supported: 'Spotify сейчас не разрешает эту команду.', rejected: 'Spotify не выполнил команду. Попробуй ещё раз.',
  busy: 'Подожди, предыдущая команда ещё выполняется.', timeout: 'Spotify долго не отвечает. Попробуй ещё раз.',
  unavailable: 'Не удалось связаться со Spotify.', unsupported: 'Управление Spotify доступно в Windows.',
};
const failure = code => ({ ok: false, local: true, code, error: ERRORS[code] || ERRORS.unavailable });
const sessionId = value => typeof value === 'string' && SESSION_ID.test(value) ? value : null;
const controls = raw => Object.fromEntries(ACTIONS.map(action => [action, raw?.[action] === true]));

function createControl(options = {}) {
  let pending = false;
  return async function control(request, cfg = {}) {
    if (cfg.companionContext === false || cfg.spotifyWidget === false) return failure('disabled');
    if (!ACTIONS.includes(request?.action) || !sessionId(request?.sessionId)) return failure('invalid_request');
    if ((options.platform || process.platform) !== 'win32') return failure('unsupported');
    if (pending) return failure('busy');
    pending = true;
    try {
      const result = await new Promise(resolve => {
        const invoke = options.execFile || execFile;
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const child = invoke(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { windowsHide: true, timeout: 12000, maxBuffer: 8192, encoding: 'utf8' }, (error, output) => {
            if (error || typeof output !== 'string' || output.length > 8192) return resolve(failure(error?.killed ? 'timeout' : 'unavailable'));
            try {
              const raw = JSON.parse(output.replace(/^\uFEFF/, '').trim());
              if (!raw || raw.ok !== true) return resolve(failure(Object.hasOwn(ERRORS, raw?.code) ? raw.code : 'unavailable'));
              resolve({ ok: true, local: true, action: request.action, playing: typeof raw.playing === 'boolean' ? raw.playing : null, controls: controls(raw.controls) });
            } catch { resolve(failure('unavailable')); }
          });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ action: request.action, sessionId: request.sessionId }));
      });
      return result;
    } catch { return failure('unavailable'); }
    finally { pending = false; }
  };
}

module.exports = { control: createControl(), createControl, sessionId, controls, failure };
