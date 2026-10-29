import { reducedMotion } from './util.js';

// Extra quiet moments of acting, using the original exposure sheets and FX renderer.
// She never talks from this scheduler and never takes over a stronger action.
const PROFILES = Object.freeze({
  full: { small: [5000, 15000], glitch: [20000, 45000], large: [60000, 120000] },
  normal: { small: [20000, 40000], glitch: [45000, 90000], large: [120000, 180000] },
});

export class CompanionActing {
  constructor({ capri, fx, voice, panel, chat, guide, host }, options = {}) {
    Object.assign(this, { capri, fx, voice, panel, chat, guide, host });
    this.now = options.now || (() => performance.now());
    this.random = options.random || Math.random;
    this.isReduced = options.reduced || (() => reducedMotion.matches);
    this.clearTimer = options.clearInterval || ((id) => clearInterval(id));
    this.level = 'full';
    this.disposed = false;
    this.performing = false;
    this.gameActive = false;
    this.lastAct = null;
    this.lastEffectAt = -Infinity;
    this.schedule(this.now());
    this.removeConfig = host?.onConfig?.((cfg) => this.configure(cfg));
    this.removeWindows = host?.onWindows?.((data) => { this.gameActive = Boolean(data?.game); });
    host?.getConfig?.().then((cfg) => this.configure(cfg)).catch(() => {});
    host?.windowsNow?.().then((data) => { this.gameActive = Boolean(data?.game); }).catch(() => {});
    const setTimer = options.setInterval || ((fn, ms) => setInterval(fn, ms));
    this.timer = setTimer(() => this.tick(), 1000);
  }

  configure(cfg = {}) {
    const level = ['quiet', 'normal', 'full'].includes(cfg.effectLevel) ? cfg.effectLevel : 'full';
    if (level !== this.level) {
      this.level = level;
      this.schedule(this.now());
    }
  }

  delay(kind) {
    const [low, high] = (PROFILES[this.level] || PROFILES.normal)[kind];
    const value = Math.max(0, Math.min(1, Number(this.random()) || 0));
    return low + value * (high - low);
  }

  schedule(at) {
    this.next = Object.fromEntries(['small', 'glitch', 'large'].map((kind) => [kind, at + this.delay(kind)]));
  }

  get available() {
    const c = this.capri;
    return !this.disposed && this.level !== 'quiet' && !this.isReduced() && !this.performing && !this.gameActive
      && c?.free === true && c.mode === 'idle' && !c.busy && !c.act && !c.dragging && !c.stowed
      && !c.dormant && !c.hidden && ['stand', 'sit'].includes(c.stance)
      && !this.panel?.visible && !this.chat?.open && !this.guide?.running;
  }

  pickAct(names) {
    const choices = names.filter((name) => name !== this.lastAct);
    if (!choices.length) return null;
    const index = Math.min(choices.length - 1, Math.floor(Math.max(0, Math.min(1, Number(this.random()) || 0)) * choices.length));
    return choices[index];
  }

  act(name) {
    if (!name) return false;
    this.lastAct = name;
    this.performing = true;
    try {
      Promise.resolve(this.capri.perform(name, this.capri.towardCenter?.() || 1))
        .catch(() => {})
        .finally(() => { this.performing = false; });
      return true;
    } catch {
      this.performing = false;
      return false;
    }
  }

  tick() {
    if (this.disposed) return null;
    const at = this.now();
    if (!this.available) {
      // A missed opportunity disappears; she doesn't burst into action after a conversation.
      if (Object.values(this.next).some((due) => at >= due)) this.schedule(at);
      return null;
    }
    if (at - this.lastEffectAt < 2000) return null;
    let kind = null;
    if (at >= this.next.large) {
      this.next.large = at + this.delay('large');
      const names = this.capri.stance === 'sit' ? ['split'] : ['spin', 'hop', 'split'];
      const name = this.pickAct(names);
      if (this.act(name)) kind = name;
    } else if (at >= this.next.glitch) {
      this.next.glitch = at + this.delay('glitch');
      // pulse() is the original single-exposure glitch (one 12fps drawing, about83ms).
      this.capri.pulse();
      const head = this.capri.head?.();
      if (head && Number.isFinite(head.x) && Number.isFinite(head.y) && this.level === 'full') {
        const scale = Math.max(0.3, Math.min(1.2, this.capri.scale || 0.6));
        this.fx?.slices?.(head.x, head.y - 24 * scale, 75 * scale, 60 * scale, { count: 2, life: 120 });
      }
      kind = 'glitch';
    } else if (at >= this.next.small) {
      this.next.small = at + this.delay('small');
      const name = this.pickAct(['curious', 'look']);
      if (this.act(name)) kind = name;
    }
    if (kind) {
      this.lastEffectAt = at;
      for (const key of Object.keys(this.next)) this.next[key] = Math.max(this.next[key], at + 2000);
    }
    return kind;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer(this.timer);
    this.removeConfig?.(); this.removeWindows?.();
  }
}
