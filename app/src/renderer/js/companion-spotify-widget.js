// A local Spotify session card. Metadata never becomes markup or a remote image request.
const MAX_COVER_CHARS = 40000;
const clamp = (value, low, high) => Math.max(low, Math.min(Math.max(low, high), value));
const clean = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
const SPOTIFY_SESSION = /^(?:Spotify(?:\.exe)?|SpotifyAB\.SpotifyMusic_zpdnekdrzrea0!Spotify)$/i;

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
    this.pending = false;
    this.feedbackUntil = 0;
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
    this.controls = make('div', 'companion-spotify-widget__controls', this.el);
    this.controls.setAttribute('role', 'group');
    this.controls.setAttribute('aria-label', 'Управление Spotify');
    this.buttons = {};
    for (const [action, glyph, label] of [['previous', '⏮', 'Предыдущий трек'], ['toggle', 'Ⅱ', 'Пауза'], ['next', '⏭', 'Следующий трек'], ['dance', '✦', 'Потанцуй под музыку']]) {
      const button = make('button', `companion-spotify-widget__button companion-spotify-widget__button--${action}`, this.controls);
      button.type = 'button'; button.textContent = glyph; button.title = label;
      button.setAttribute('aria-label', label); button.disabled = true;
      button.addEventListener('click', event => { event.stopPropagation(); this.command(action); });
      this.buttons[action] = button;
    }
    this.feedback = make('div', 'companion-spotify-widget__feedback', this.el);
    this.feedback.setAttribute('role', 'status'); this.feedback.setAttribute('aria-live', 'polite'); this.feedback.hidden = true;
    const close = make('button', 'companion-spotify-widget__close', this.el);
    close.type = 'button'; close.textContent = '×'; close.title = 'Скрыть карточку Spotify';
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.configure({ ...this.cfg, spotifyWidget: false });
      Promise.resolve(host.setConfig?.({ spotifyWidget: false })).catch(() => {});
    });
    for (const name of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup']) {
      this.el.addEventListener(name, event => { event.stopPropagation(); if (name === 'contextmenu') event.preventDefault(); });
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
      sessionId: typeof raw.sessionId === 'string' && SPOTIFY_SESSION.test(raw.sessionId) ? raw.sessionId : null,
      controls: Object.fromEntries(['previous', 'play', 'pause', 'next'].map(action => [action, raw.controls?.[action] === true])),
    } : null;
    this.updatedAt = Number.isFinite(state?.updatedAt) ? state.updatedAt : this.now();
    this.render();
  }

  canControl(action) {
    const song = this.music;
    const age = this.now() - this.updatedAt;
    if (this.disposed || this.pending || !song || age < -2000 || age > 20000) return false;
    if (action === 'dance') return song.playing === true && typeof this.host.spotifyDance === 'function';
    return song.source === 'gsmtc' && typeof song.sessionId === 'string' && SPOTIFY_SESSION.test(song.sessionId) &&
      typeof this.host.spotifyControl === 'function' && song.controls?.[action] === true;
  }

  async command(choice) {
    const action = choice === 'toggle' ? (this.music?.playing === true ? 'pause' : 'play') : choice;
    if (!['previous', 'play', 'pause', 'next', 'dance'].includes(action) || !this.canControl(action)) return;
    const session = this.music.sessionId;
    this.pending = true; this.feedback.textContent = 'Секунду…'; this.feedbackUntil = Infinity; this.feedback.setAttribute('data-error', 'false');
    this.render();
    try {
      const result = action === 'dance' ? await this.host.spotifyDance() : await this.host.spotifyControl({ action, sessionId: session });
      if (this.disposed) return;
      if (result?.ok !== true) throw new Error(clean(result?.error) || 'Не получилось. Попробуй ещё раз.');
      if (action !== 'dance' && this.music?.sessionId === session) {
        if (typeof result.playing === 'boolean') this.music.playing = result.playing;
        if (result.controls) this.music.controls = Object.fromEntries(['previous', 'play', 'pause', 'next'].map(key => [key, result.controls[key] === true]));
      }
      this.feedback.textContent = action === 'dance' ? 'Лови танец ✦' : ({ previous: 'Предыдущий трек ✓', next: 'Следующий трек ✓', pause: 'Пауза ✓', play: 'Включаю музыку ✓' })[action];
      this.feedbackUntil = this.now() + 3500;
    } catch (error) {
      if (this.disposed) return;
      this.feedback.textContent = clean(error?.message) || 'Spotify не ответил. Попробуй ещё раз.';
      this.feedback.setAttribute('data-error', 'true'); this.feedbackUntil = this.now() + 8000;
    } finally { this.pending = false; if (!this.disposed) this.render(); }
  }

  render() {
    const hidden = this.disposed || this.cfg.spotifyWidget === false || this.cfg.companionContext === false ||
      !this.music || this.capri.hidden || this.capri.stowed || this.capri.dormant || this.capri.mode === 'sleep' || this.capri.dragging ||
      this.panel?.visible || this.chat?.open;
    this.el.hidden = Boolean(hidden);
    if (hidden) return;
    this.el.setAttribute('aria-busy', String(this.pending));
    const song = this.music;
    this.title.textContent = song.title;
    this.title.title = song.title;
    this.artist.textContent = song.artist || song.album || 'Spotify';
    this.artist.title = [song.artist, song.album].filter(Boolean).join(' · ');
    const label = song.playing === true ? 'ИГРАЕТ' : song.playing === false ? 'ПАУЗА' : 'ТРЕК';
    this.heading.textContent = `SPOTIFY / ${label}`;
    const toggle = song.playing === true ? 'pause' : 'play';
    const toggleLabel = toggle === 'pause' ? 'Пауза' : 'Продолжить';
    this.buttons.toggle.textContent = toggle === 'pause' ? 'Ⅱ' : '▶';
    this.buttons.toggle.title = toggleLabel; this.buttons.toggle.setAttribute('aria-label', toggleLabel);
    for (const [key, button] of Object.entries(this.buttons)) {
      button.disabled = !this.canControl(key === 'toggle' ? toggle : key);
    }
    this.controls.title = song.source !== 'gsmtc' || !song.sessionId ? 'Управление доступно для приложения Spotify через Windows.' : '';
    this.feedback.hidden = this.now() > this.feedbackUntil || !this.feedback.textContent;
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
    const at = spotifyPlacement(head, viewport, this.el.offsetWidth || 244, this.el.offsetHeight || 122, this.capri.scale);
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
