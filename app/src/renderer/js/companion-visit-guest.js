import { SpriteRenderer, SPRITE } from './sprite.js';
import { Player, NEUTRAL } from './acting.js';

export const visitName = value => typeof value === 'string'
  ? Array.from(value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 24).join('') || 'Капри'
  : 'Капри';

export function visitGuest(value) {
  if (!value || typeof value !== 'object' || typeof value.visitId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.visitId)) return null;
  return { visitId: value.visitId, name: visitName(value.name), mood: ['idle', 'happy', 'curious', 'sleep'].includes(value.mood) ? value.mood : 'idle', facing: value.facing === -1 ? -1 : 1,
    scale: typeof value.scale === 'number' && Number.isFinite(value.scale) ? Math.max(0.4, Math.min(0.8, value.scale)) : 0.55 };
}

// One read-only local sprite, not a second Capri instance. It owns no mouse,
// keyboard, drag, cloud, capture or network handlers.
export class GuestSprite {
  constructor({ image, guest }, options = {}) {
    this.document = options.document || document;
    this.window = options.window || window;
    this.now = options.now || (() => performance.now());
    this.raf = options.requestAnimationFrame || (callback => requestAnimationFrame(callback));
    this.cancel = options.cancelAnimationFrame || (id => cancelAnimationFrame(id));
    this.reduced = options.reduced || (() => false);
    this.Renderer = options.SpriteRenderer || SpriteRenderer;
    this.Player = options.Player || Player;
    this.cfg = {}; this.disposed = false; this.frame = null; this.lastFrame = -Infinity; this.createdAt = this.now();
    this.root = this.document.createElement('div'); this.root.className = 'companion-visit-guest';
    this.root.setAttribute('role', 'img'); this.root.style.pointerEvents = 'none';
    this.canvas = this.document.createElement('canvas'); this.canvas.setAttribute('aria-hidden', 'true'); this.canvas.tabIndex = -1;
    this.label = this.document.createElement('div'); this.label.className = 'companion-visit-guest__name';
    this.root.appendChild(this.canvas); this.root.appendChild(this.label); this.document.body.appendChild(this.root);
    try { this.sprite = new this.Renderer(this.canvas, image); }
    catch {
      // Original local art remains visible even if another WebGL context is unavailable.
      this.canvas.remove(); this.canvas = this.document.createElement('canvas'); this.canvas.setAttribute('aria-hidden', 'true');
      this.root.insertBefore(this.canvas, this.label); this.context = this.canvas.getContext('2d'); this.image = image;
    }
    this.onResize = () => this.render(this.now(), true);
    this.window.addEventListener('resize', this.onResize);
    this.update(guest);
  }

  update(value) {
    const guest = visitGuest(value);
    if (!guest || this.disposed) return false;
    this.guest = guest;
    this.label.textContent = `В гостях · ${guest.name}`;
    this.root.setAttribute('aria-label', `Гостевая Капри: ${guest.name}`);
    const pose = guest.mood === 'sleep' ? 'sleep' : guest.mood === 'curious' ? 'curious' : 'stand';
    if (!this.player || this.pose !== pose) { this.player = new this.Player(pose, { at: this.now() }); this.pose = pose; }
    if (this.sprite) { if (this.sprite.scale !== guest.scale) this.sprite.resize(guest.scale); }
    else {
      this.canvas.width = Math.round((SPRITE.width + SPRITE.pad * 2) * guest.scale);
      this.canvas.height = Math.round((SPRITE.height + SPRITE.pad * 2) * guest.scale);
    }
    this.render(this.now(), true); this.schedule(); return true;
  }

  configure(cfg = {}) { this.cfg = cfg; this.render(this.now(), true); this.schedule(); }

  schedule() {
    if (this.disposed || this.root.hidden || this.reduced() || this.frame !== null) return;
    this.frame = this.raf(now => { this.frame = null; this.render(now); this.schedule(); });
  }

  render(now, force = false) {
    if (this.disposed || !this.guest) return;
    const hidden = this.cfg.visible === false;
    this.root.hidden = hidden;
    if (hidden || this.reduced()) { if (this.frame !== null) this.cancel(this.frame); this.frame = null; }
    if (hidden || (!force && now - this.lastFrame < 1000 / 12)) return;
    this.lastFrame = now;
    const reduced = this.reduced(), scale = this.guest.scale;
    const width = Math.round((SPRITE.width + SPRITE.pad * 2) * scale), height = Math.round((SPRITE.height + SPRITE.pad * 2) * scale);
    this.root.style.width = `${width}px`;
    const viewport = { w: Math.max(width + 20, this.window.innerWidth || 1000), h: Math.max(height + 35, this.window.innerHeight || 700) };
    const age = Math.max(0, now - this.createdAt);
    const entering = reduced ? 1 : Math.min(1, age / 1100);
    const edge = this.guest.facing === 1 ? 18 : viewport.w - width - 18;
    const outside = this.guest.facing === 1 ? -width : viewport.w;
    const drift = reduced || entering < 1 ? 0 : Math.sin((age - 1100) / 8000) * Math.min(36, viewport.w * 0.05);
    const x = Math.max(0, Math.min(viewport.w - width, outside + (edge - outside) * entering + drift));
    const y = viewport.h - height - 26 + (reduced ? 0 : Math.sin(age / 1000) * 3);
    this.root.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    this.root.style.opacity = String(reduced ? 1 : Math.min(1, age / 500));
    const sample = reduced ? null : this.player.sample(now);
    const pose = { ...NEUTRAL, ...(sample ? this.player.resolve(sample.pose, this.guest.facing) : {}) };
    this.canvas.style.transform = `rotate(${reduced ? 0 : pose.tilt || 0}deg) scaleX(${this.guest.facing})`;
    if (this.sprite) this.sprite.draw({ ...pose, seed: Math.floor(now / (1000 / 12)), boil: reduced ? 0 : 0.16, sit: 0, glitch: reduced ? 0 : entering < 1 ? (1 - entering) * 0.3 : 0,
      glitchSeed: Math.floor(now / 160), split: 0, collapse: reduced ? 0 : (1 - entering) * 0.45, dissolve: 0, sparkle: 0.65, grade: 1, sil: [1, 1, 1], silAmount: 0, misreg: [1, 1], alpha: 1 });
    else if (this.context && this.image) {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.context.drawImage(this.image, SPRITE.pad * scale, SPRITE.pad * scale, SPRITE.width * scale, SPRITE.height * scale);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) this.cancel(this.frame); this.frame = null;
    this.window.removeEventListener('resize', this.onResize);
    try { this.sprite?.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
    this.root.remove(); this.sprite = null; this.context = null; this.image = null;
  }
}
