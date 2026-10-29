// Authored, finite companionship: no model calls and no claims about unseen content.
// Missed opportunities disappear rather than interrupting the user later.
import { COMPANION_IDLE_LINES } from './lines.js';

export class CompanionIdle {
  constructor({ capri, panel, brain, chat, guide, host }, options = {}) {
    Object.assign(this, { capri, panel, brain, chat, guide, host });
    this.now = options.now || (() => performance.now());
    this.random = options.random || Math.random;
    this.clearTimer = options.clearInterval || clearInterval;
    this.enabled = true;
    this.interval = 5 * 60000;
    this.nextAt = this.now() + 60000;
    this.lastLine = null;
    this.shown = 0;
    this.usedLines = new Set();
    this.gameActive = false;
    this.language = 'ru';
    this.removeConfig = host?.onConfig?.((cfg) => this.configure(cfg));
    this.removeWindows = host?.onWindows?.((data) => { this.gameActive = Boolean(data?.game); });
    host?.getConfig?.().then((cfg) => this.configure(cfg)).catch(() => {});
    host?.windowsNow?.().then((data) => { this.gameActive = Boolean(data?.game); }).catch(() => {});
    const setTimer = options.setInterval || setInterval;
    this.timer = setTimer(() => this.tick(), 5000);
  }

  configure(cfg = {}) {
    const enabled = cfg.ambientSpeech !== false;
    const minutes = Number(cfg.ambientIntervalMinutes);
    const interval = (Number.isFinite(minutes) ? Math.max(2, Math.min(30, minutes)) : 5) * 60000;
    if (enabled !== this.enabled || interval !== this.interval) this.nextAt = this.now() + interval;
    this.enabled = enabled;
    this.interval = interval;
    const language = cfg.responseLanguage === 'ja' ? 'ja' : 'ru';
    if (language !== this.language) { this.usedLines.clear(); this.shown = 0; this.lastLine = null; }
    this.language = language;
  }

  get available() {
    const c = this.capri;
    return !this.disposed && this.enabled && !this.gameActive && c?.free === true && c.mode === 'idle'
      && !c.busy && !c.act && !c.dragging && !c.stowed && !c.dormant && !c.hidden
      && ['stand', 'sit'].includes(c.stance) && !this.panel.visible && !this.chat?.open && !this.guide?.running;
  }

  tick() {
    if (this.disposed || this.now() < this.nextAt) return false;
    this.nextAt = this.now() + this.interval;
    if (!this.available) return false;
    const bank = COMPANION_IDLE_LINES[this.language] || COMPANION_IDLE_LINES.ru;
    // Short opening lines can be cached by the optional local voice module.
    const pool = this.language === 'ru' && this.shown < 4 ? bank.slice(0, 4) : bank;
    if (pool.every(line => this.usedLines.has(line))) this.usedLines.clear();
    const lines = pool.filter((line) => line !== this.lastLine && !this.usedLines.has(line));
    const value = Math.max(0, Math.min(0.999999, Number(this.random()) || 0));
    const line = lines[Math.floor(value * lines.length)];
    if (!line) return false;
    if (this.panel.say({ kind: 'idle', ambient: true, face: 'smug', line, hold: 7000 }) === false) return false;
    this.lastLine = line;
    this.usedLines.add(line);
    this.shown++;
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer(this.timer);
    this.removeConfig?.(); this.removeWindows?.();
  }
}
