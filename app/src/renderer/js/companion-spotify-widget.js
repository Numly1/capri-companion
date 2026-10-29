// A local Spotify session card. Metadata never becomes markup or a remote image request.
const MAX_COVER_CHARS = 40000;
const clamp = (value, low, high) => Math.max(low, Math.min(Math.max(low, high), value));
const clean = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';

export function spotifyCover(value) {
  return typeof value === 'string' && value.length <= MAX_COVER_CHARS &&
    /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

export function spotifyProgress(music, updatedAt, now = Date.now()) {
  const duration = Number(music?.durationMs);
  const position = Number(music?.positionMs);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60 * 1000 ||
      !Number.isFinite(position) || position < 0) return null;
  // A stale session must not appear to keep playing forever after its helper disappears.
  const elapsed = music.playing === true && Number.isFinite(updatedAt) ? clamp(now - updatedAt, 0, 15000) : 0;
  const at = clamp(position + elapsed, 0, duration);
  return { position: at, duration, fraction: at / duration };
}

export function spotifyPlacement(head, viewport, width = 244, height = 88, scale = 0.6) {
  const gap = Math.max(42, 72 * scale);
  const right = head.x + gap;
  const preferred = right + width + 10 <= viewport.w ? right : head.x - gap - width;
  return { x: clamp(preferred, 10, viewport.w - width - 10), y: clamp(head.y - 26, 10, viewport.h - height - 10) };
}

/** Instantiate after Chat; include containsPoint in the overlay's click-through test. */
export class CompanionSpotifyWidget {
  constructor({ capri, host, panel, chat }, options = {}) {
    Object.assign(this, { capri, host, panel, chat });
    this.now = options.now || Date.now;
    this.cfg = {};
    this.music = null;
    this.updatedAt = 0;
    this.disposed = false;
    this.document = options.document || document;
    this.window = options.window || window;
    const make = (tag, className, parent) => {
      const el = this.document.createElement(tag);
      el.className = className;
      if (parent) parent.appendChild(el);
      return el;
    };
    this.style = make('link', 'companion-spotify-widget-style', this.document.head);
    this.style.rel = 'stylesheet';
    this.style.href = 'styles/companion-spotify-widget.css';
    this.el = make('section', 'companion-spotify-widget', this.document.body);
    this.el.setAttribute('aria-label', 'Сейчас в Spotify');
    this.el.hidden = true;
    this.cover = make('div', 'companion-spotify-widget__cover', this.el);
    this.cover.setAttribute('aria-hidden', 'true');
    const note = make('span', '', this.cover); note.textContent = '♪';
    this.image = make('img', '', this.cover);
    this.image.alt = '';
    this.image.hidden = true;
    this.image.addEventListener('error', () => { this.image.hidden = true; });
    this.heading = make('div', 'companion-spotify-widget__heading', this.el);
    this.title = make('div', 'companion-spotify-widget__title', this.el);
    this.artist = make('div', 'companion-spotify-widget__artist', this.el);
    this.track = make('div', 'companion-spotify-widget__track', this.el);
    this.track.setAttribute('role', 'progressbar');
    this.track.setAttribute('aria-label', 'Прогресс трека');
    this.track.setAttribute('aria-valuemin', '0');
    this.track.setAttribute('aria-valuemax', '100');
    this.fill = make('div', 'companion-spotify-widget__fill', this.track);
    const close = make('button', 'companion-spotify-widget__close', this.el);
    close.type = 'button'; close.textContent = '×'; close.title = 'Скрыть карточку Spotify';
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.configure({ ...this.cfg, spotifyWidget: false });
      Promise.resolve(host.setConfig?.({ spotifyWidget: false })).catch(() => {});
    });
    for (const name of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu']) {
      this.el.addEventListener(name, event => event.stopPropagation());
    }
    this.removeContext = host.onCompanionContext?.(event => this.onSnapshot(event));
    this.removeConfig = host.onConfig?.(cfg => this.configure(cfg));
    host.getConfig?.().then(cfg => this.configure(cfg)).catch(() => {});
    host.companionContext?.().then(state => this.onSnapshot({ state })).catch(() => {});
    this.timer = (options.setInterval || setInterval)(() => this.render(), 250);
    this.clearTimer = options.clearInterval || clearInterval;
  }

  configure(cfg = {}) {
    if (this.disposed) return;
    this.cfg = cfg;
    this.render();
  }

  onSnapshot(event) {
    if (this.disposed) return;
    const state = event?.state;
    const raw = state?.music;
    this.music = state?.available !== false && clean(raw?.title) && ['gsmtc', 'window-title'].includes(raw?.source) ? {
      title: clean(raw.title), artist: clean(raw.artist), album: clean(raw.album), source: raw.source,
      cover: spotifyCover(raw.cover), playing: typeof raw.playing === 'boolean' ? raw.playing : null,
      positionMs: raw.positionMs, durationMs: raw.durationMs,
    } : null;
    this.updatedAt = Number.isFinite(state?.updatedAt) ? state.updatedAt : this.now();
    this.render();
  }

  render() {
    const hidden = this.disposed || this.cfg.spotifyWidget === false || this.cfg.companionContext === false ||
      !this.music || this.capri.hidden || this.capri.stowed || this.capri.dormant || this.capri.dragging ||
      this.panel?.visible || this.chat?.open;
    this.el.hidden = Boolean(hidden);
    if (hidden) return;
    const song = this.music;
    this.title.textContent = song.title;
    this.title.title = song.title;
    this.artist.textContent = song.artist || song.album || 'Spotify';
    this.artist.title = [song.artist, song.album].filter(Boolean).join(' · ');
    const label = song.playing === true ? 'ИГРАЕТ' : song.playing === false ? 'ПАУЗА' : 'ТРЕК';
    this.heading.textContent = `SPOTIFY / ${label}`;
    if (song.cover !== this.image.getAttribute('src')) {
      if (song.cover) { this.image.setAttribute('src', song.cover); this.image.hidden = false; }
      else { this.image.removeAttribute('src'); this.image.hidden = true; }
    }
    const progress = spotifyProgress(song, this.updatedAt, this.now());
    this.track.hidden = !progress;
    if (progress) {
      this.fill.style.transform = `scaleX(${progress.fraction.toFixed(4)})`;
      this.track.setAttribute('aria-valuenow', String(Math.round(progress.fraction * 100)));
    }
    const head = this.capri.head();
    const viewport = { w: this.window.innerWidth, h: Math.min(this.window.innerHeight, this.capri.view?.floor || this.window.innerHeight) };
    const at = spotifyPlacement(head, viewport, this.el.offsetWidth || 244, this.el.offsetHeight || 88, this.capri.scale);
    this.el.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px)`;
  }

  containsPoint(x, y) {
    if (this.disposed || this.el.hidden) return false;
    const r = this.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  dispose() {
    this.disposed = true;
    this.clearTimer(this.timer);
    this.removeContext?.(); this.removeConfig?.();
    this.el.remove(); this.style.remove();
  }
}
