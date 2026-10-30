'use strict';

// Only a foreground Kinopoisk title and playback metadata. No frames, subtitles or cloud calls.
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140) : '';
function sanitizeWatching(raw) {
  if (raw?.service !== 'Кинопоиск' || !['gsmtc', 'window-title'].includes(raw.source)) return null;
  const title = clean(raw.title);
  if (!title || /^(?:Кинопоиск|Kinopoisk|Главная|Фильмы и сериалы)$/i.test(title) || /https?:\/\/|[\\/]Users[\\/]/i.test(title)) return null;
  return { service: 'Кинопоиск', title, playing: raw.playing === true ? true : raw.playing === false ? false : null, source: raw.source };
}
const LINES = [
  'Кинопоиск пойман. Смотрим «{title}»? Устроилась рядом. Спойлеры держу за зубами.',
  'Я тут, чум. У нас маленький совместный просмотр. Иногда помолчу — хороший момент тоже надо дать досмотреть.',
  'Неоновый угол занят Капри. Смотри спокойно, я составлю компанию.',
  'Цифровой попкорн готов. Реальный, если что, на тебе, чум.',
  'Мне нравится наш режим: ты отдыхаешь, я рядом. Никуда не торопимся.',
  'Если захочется обсудить увиденное — напиши мне. Пока смотрим дальше без спойлеров.',
  'Вот ради таких вечеров и стоит иногда откладывать все дела. Я на посту уютного хаоса.',
  'Маленький перерыв для глаз никто не отменял. Когда будет удобная пауза — моргни за нас обеих.',
];
class WatchingTracker {
  constructor({ now = Date.now, random = Math.random } = {}) {
    this.now = now; this.random = random; this.session = null; this.lastAt = -Infinity; this.previous = -1; this.sequence = 0;
  }
  sample(raw, cfg = {}) {
    const enabled = cfg.watchMode === 'auto' || cfg.watchMode === 'manual';
    let watching = enabled ? sanitizeWatching(raw) : null;
    if (watching && watching.playing === null && cfg.watchMode === 'manual') watching = { ...watching, playing: true };
    const at = this.now();
    if (!watching || watching.playing !== true) this.session = null;
    else if (this.session?.title !== watching.title) this.session = { title: watching.title, since: at };
    let reaction = null;
    const minutes = typeof cfg.watchIntervalMinutes === 'number' && Number.isFinite(cfg.watchIntervalMinutes) ? Math.max(5, Math.min(60, cfg.watchIntervalMinutes)) : 12;
    if (this.session && at - this.session.since >= 120000 && at - this.lastAt >= minutes * 60000) {
      let index = Math.max(0, Math.min(LINES.length - 1, Math.floor(this.random() * LINES.length)));
      if (index === this.previous) index = (index + 1) % LINES.length;
      this.previous = index; this.lastAt = at;
      reaction = { id: ++this.sequence, line: LINES[index].replace('{title}', watching.title), source: 'local-metadata' };
    }
    return { state: { enabled, watching }, reaction };
  }
}
module.exports = { WatchingTracker, sanitizeWatching };
