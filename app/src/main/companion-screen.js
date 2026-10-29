'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const script = require('./companion-screen-script');

const APPS = Object.freeze({
  krita: 'Krita', spotify: 'Spotify', chrome: 'Google Chrome', thorium: 'Thorium', msedge: 'Microsoft Edge',
  firefox: 'Firefox', brave: 'Brave', opera: 'Opera', explorer: 'Проводник Windows', notepad: 'Блокнот',
  photoshop: 'Adobe Photoshop', code: 'Visual Studio Code', discord: 'Discord', steam: 'Steam',
  java: 'Java-приложение', javaw: 'Java-приложение', mspaint: 'Paint',
});
const ERRORS = Object.freeze({
  invalid_bounds: 'Не удалось определить область экрана для локального просмотра.',
  ocr_unavailable: 'Распознавание текста Windows недоступно. Добавь распознавание текста в параметрах языка Windows.',
  capture_failed: 'Не удалось прочитать экран локально. Попробуй ещё раз, когда нужное окно видно.',
  unsupported: 'Локальный просмотр экрана доступен в Windows.',
});
const failure = code => ({ ok: false, local: true, code, error: ERRORS[code] || ERRORS.capture_failed });

// Coordinates are physical pixels, not Electron display DIPs. The main process supplies one display.
function boundsFor(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(value[key]))) return null;
  const { x, y, width, height } = value;
  if (Math.abs(x) > 32768 || Math.abs(y) > 32768 || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 33554432) return null;
  return { x, y, width, height };
}

function normalize(raw) {
  if (!raw || raw.ok !== true) return failure(raw?.code === 'ocr_unavailable' ? 'ocr_unavailable' : 'capture_failed');
  const text = typeof raw.text === 'string' ? raw.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 3000) : '';
  const appName = APPS[String(raw.app || '').toLowerCase()] || null;
  const language = typeof raw.language === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(raw.language) ? raw.language : null;
  const excerpt = text.slice(0, 650);
  const intro = appName ? `На переднем плане ${appName}. ` : '';
  const line = text ? `${intro}Локально прочитала надписи на экране:\n«${excerpt}${text.length > excerpt.length ? '…' : ''}»\nЭто распознавание текста: возможны ошибки. Смысл рисунка без ИИ я не определяю.`
    : `${intro}Снимок просмотрен локально, но читаемый текст не найден. Без ИИ я не определяю, что изображено на рисунке.`;
  return { ok: true, local: true, text, appName, language, line };
}

function run(request, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return Promise.resolve(failure('unsupported'));
  const invoke = options.execFile || execFile;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    const child = invoke(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, output) => {
        if (error || typeof output !== 'string' || output.length > 64000) return resolve(failure('capture_failed'));
        try { resolve(normalize(JSON.parse(output.replace(/^\uFEFF/, '').trim()))); }
        catch { resolve(failure('capture_failed')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

function inspect(request, options) {
  const bounds = boundsFor(request?.bounds);
  if (!bounds) return Promise.resolve(failure('invalid_bounds'));
  // Deliberately copy only coordinates. No paths, scripts, OCR fixtures or other request keys pass through.
  return run({ bounds, excludePid: process.pid }, options);
}

// A deterministic in-memory image for a real Windows OCR check; never captures the user's screen.
function inspectFixture(options) { return run({ fixture: true, excludePid: process.pid }, options); }

module.exports = { inspect, inspectFixture, boundsFor, normalize };
