'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const voiceScript = require('./companion-voice-script');
const { bundledVoice } = require('./companion-voice-clips');
let startReferenceVoice = null;
function setReferenceStarter(start) { startReferenceVoice = start; }

const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_REPLY = 256 * 1024;
const MIME = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'mp4' };
const failure = (error) => ({ ok: false, error });

function customEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('address'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !loopback)
      || url.username || url.password || url.search || url.hash) throw new Error('address');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`;
  return url.toString();
}

/** Explicit recorded input only. Never reads the microphone or stores audio on disk. */
async function transcribe(payload, cfg = {}, openKeys = (keys) => keys, fetchImpl = fetch) {
  if (cfg.offlineChat !== false)
    return failure('В обычном режиме голосовой ввод отключён. Включи ИИ и подключи Groq либо используй текст.');
  const { audio, mime, language } = payload || {};
  if ((!Array.isArray(audio) && !(audio instanceof Uint8Array)) || audio.length < 1 || audio.length > MAX_AUDIO)
    return failure('Запись должна содержать от 1 байта до 8 МБ. Запиши короткую фразу.');
  if (Array.isArray(audio)) {
    for (const byte of audio) if (!Number.isInteger(byte) || byte < 0 || byte > 255)
      return failure('Повреждённая аудиозапись. Попробуй ещё раз.');
  }
  const contentType = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  if (!MIME[contentType]) return failure('Неподдерживаемый формат записи. Используй микрофон в приложении.');
  if (language != null && !['ru', 'ja'].includes(language)) return failure('Выбери русский или японский язык.');
  const provider = cfg.provider;
  if (!['groq', 'openai', 'custom'].includes(provider))
    return failure('Этот сервис не поддерживает голосовой ввод здесь. Выбери Groq, OpenAI или совместимый сервис; текст остаётся доступен.');
  let endpoint;
  try {
    endpoint = provider === 'groq' ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : provider === 'openai' ? 'https://api.openai.com/v1/audio/transcriptions' : customEndpoint(cfg.customUrl);
  } catch { return failure('Укажи HTTPS-адрес сервиса. HTTP разрешён только для localhost.'); }
  let key;
  try { key = (openKeys(cfg.apiKeys || {})?.[provider] || '').trim(); }
  catch { return failure('Не удалось открыть сохранённый ключ. Введи его заново в настройках.'); }
  if ((provider !== 'custom' && !key) || typeof key !== 'string' || key.length > 20000 || /\s/.test(key))
    return failure('Добавь корректный API-ключ выбранного сервиса в настройках.');
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(audio)], { type: contentType }), `capri-recording.${MIME[contentType]}`);
  form.append('model', provider === 'groq' ? 'whisper-large-v3-turbo' : provider === 'openai' ? 'gpt-transcribe' : 'whisper-1');
  if (language && provider !== 'openai') form.append('language', language);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', body: form, headers: key ? { authorization: `Bearer ${key}` } : {},
      redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) return failure(response.status === 401 || response.status === 403
      ? 'Сервис отклонил ключ или доступ к распознаванию речи.'
      : response.status === 429 ? 'Достигнут лимит сервиса. Попробуй позже; текстовый ввод работает.'
        : response.status === 404 ? 'Сервис не поддерживает это распознавание речи. Используй текст или Groq.'
          : 'Сервис не смог распознать запись. Попробуй ещё раз; текстовый ввод работает.');
    if (Number(response.headers.get('content-length')) > MAX_REPLY || !response.body)
      return failure('Сервис прислал неподдерживаемый ответ распознавания.');
    const chunks = [];
    let length = 0;
    for await (const part of response.body) {
      length += part.byteLength;
      if (length > MAX_REPLY) { controller.abort(); return failure('Ответ распознавания слишком большой.'); }
      chunks.push(Buffer.from(part));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text || text.length > 8000) return failure('Речь не распознана или получился слишком длинный текст. Попробуй короткую фразу.');
    return { ok: true, text };
  } catch {
    return failure(controller.signal.aborted
      ? 'Распознавание задержалось. Проверь интернет и попробуй ещё раз.'
      : 'Не удалось распознать запись. Проверь интернет и поддержку голоса у выбранного сервиса.');
  } finally { clearTimeout(timeout); }
}

async function referenceVoice(text, fetchImpl = fetch, profile = 'reference') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile === 'capri-sample' ? 180000 : 120000);
  try {
    const port = profile === 'capri-sample' ? 8795 : 8794;
    const response = await fetchImpl(`http://127.0.0.1:${port}/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice: 'capri' }), signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) {
      const code = response.status === 409 ? 'voice_busy' : response.status === 400 ? 'voice_request' : 'voice_unavailable';
      const error = code === 'voice_busy' ? 'Модуль голоса Капри занят предыдущей репликой. Попробуй ещё раз немного позже.'
        : code === 'voice_request' ? 'Модуль голоса Капри не смог принять эту реплику.'
        : 'Модуль голоса Капри сейчас недоступен. Текстовый ответ остаётся доступен.';
      return { ...failure(error), code };
    }
    if (!response.headers.get('content-type')?.startsWith('audio/wav') || !response.body)
      return { ...failure('Модуль голоса Капри вернул неподдерживаемую запись.'), code: 'voice_audio' };
    const max = 8 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) return { ...failure('Слишком длинная голосовая запись.'), code: 'voice_audio' };
    const chunks = []; let length = 0;
    for await (const part of response.body) {
      length += part.byteLength;
      if (length > max) { controller.abort(); return { ...failure('Слишком длинная голосовая запись.'), code: 'voice_audio' }; }
      chunks.push(Buffer.from(part));
    }
    const wav = Buffer.concat(chunks);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
      return { ...failure('Голосовой модуль вернул неподдерживаемую запись.'), code: 'voice_audio' };
    return { ok: true, audio: wav.toString('base64'), synthetic: true, engine: 'reference' };
  } catch { return controller.signal.aborted
    ? { ...failure('Голос Капри готовится слишком долго. Полный ответ доступен текстом; попробуй короткую реплику.'), code: 'voice_timeout' }
    : { ...failure('Не удалось соединиться с локальным модулем голоса Капри.'), code: 'voice_offline' }; }
  finally { clearTimeout(timeout); }
}

function capriSpokenText(text) {
  if (text.length <= 400) return { text, excerpt: false };
  // One bounded excerpt rather than a multi-minute queue or a different timbre.
  const sentence = text.slice(0, 161).match(/^([\s\S]{1,160}?[.!?…])(?:\s|$)/u)?.[1];
  if (sentence) return { text: sentence.trim(), excerpt: true };
  const start = text.slice(0, 157);
  const boundary = start.lastIndexOf(' ');
  return { text: `${(boundary >= 80 ? start.slice(0, boundary) : start).trimEnd()}…`, excerpt: true };
}

async function approvedVoice(text, language) {
  const selectedFailure = (result) => ({ ...result, keepSelectedVoice: true });
  if (language !== 'ru') return selectedFailure({ ...failure('Пробный голос Капри озвучивает русский. Для японского выбери другой голос.'), code: 'voice_language' });
  const prepared = bundledVoice(text);
  if (prepared) return prepared;
  try {
    if (await startReferenceVoice?.('capri-sample') === false) return selectedFailure({
      ...failure('Не удалось подключить модуль пробного голоса Капри. Готовые короткие реплики доступны; полный ответ остаётся текстом.'), code: 'voice_module',
    });
    const spoken = capriSpokenText(text);
    const result = await referenceVoice(spoken.text, fetch, 'capri-sample');
    if (!result.ok) return selectedFailure(result);
    return { ...result, ...(spoken.excerpt ? { spokenText: spoken.text, excerpt: true,
      voiceNote: 'Голосом Капри озвучено начало. Полный ответ — в тексте.' } : {}) };
  } catch { return selectedFailure({ ...failure('Не удалось запустить модуль голоса Капри. Ответ остаётся текстом.'), code: 'voice_module' }); }
}

async function synthesize(payload, cfg = {}) {
  if (cfg.companionVoice === false || cfg.muted) return Promise.resolve(failure('Озвучивание выключено.'));
  if (process.platform !== 'win32') return Promise.resolve(failure('Эта озвучка использует установленный голос Windows.'));
  const text = typeof payload?.text === 'string' ? payload.text.replace(/[*_`#]/g, '').trim().slice(0, 1200) : '';
  if (!text) return Promise.resolve(failure('Нет текста для озвучивания.'));
  const language = cfg.responseLanguage === 'ja' ? 'ja' : 'ru';
  if (cfg.voiceStyle === 'capri-sample') return approvedVoice(text, language);
  let fallbackNote;
  if (cfg.voiceStyle === 'reference') {
    if (language === 'ru') {
      try {
        const available = await startReferenceVoice?.(cfg.voiceStyle);
        if (available !== false) {
          const voice = await referenceVoice(text, fetch, cfg.voiceStyle);
          if (voice.ok) return voice;
        }
      } catch { /* The legacy experiment keeps its previous Windows fallback. */ }
    }
    fallbackNote = language === 'ru' ? 'Голос по образцу недоступен · запасной голос Windows'
      : 'Модуль по образцу сейчас озвучивает русский · запасной голос Windows';
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encodedScript = Buffer.from(voiceScript, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      { windowsHide: true, timeout: 30000, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' }, (error, output) => {
        if (error) return resolve(failure('Не удалось подготовить голос Windows. Текстовый ответ остаётся доступен.'));
        try {
          const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
          if (result.ok && typeof result.audio === 'string' && result.audio.length <= 10 * 1024 * 1024)
            return resolve({ ok: true, audio: result.audio, synthetic: true, engine: 'windows', fallbackNote });
          return resolve(failure(language === 'ja' ? 'Японский голос Windows не установлен или недоступен.' : 'Русский голос Windows не установлен или недоступен.'));
        } catch { return resolve(failure('Не удалось прочитать голосовую запись Windows.')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ text, language }));
  });
}

module.exports = { transcribe, synthesize, referenceVoice, setReferenceStarter, capriSpokenText };
