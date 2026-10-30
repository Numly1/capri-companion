// She lives in your PC, so she feels it: the processor maxed out, the charger, the battery, the
// network, things you plug in (a USB stick, a phone, a controller...) and the games you play.
// Her menu › React to my PC turns it off.

import { pick, fmt } from './util.js';

const HOT = 85; // % of the processor, for HOT_FOR
const HOT_FOR = 15000;
const HOT_EVERY = 30 * 60 * 1000;
const CHARGER_EVERY = 60 * 1000;
const PLUG_EVERY = 15 * 1000;
const GAME_AFTER = 6000;  // a game in front this long: you're playing
const GAME_OVER = 8000;   // and gone this long: you're done

const PHONE = /phone|iphone|apple|galaxy|samsung|pixel|xiaomi|redmi|poco|oneplus|huawei|honor|motorola|oppo|vivo|realme|nokia|xperia|android|mobile|t[ée]l[ée]phone|celular|телефон/i;
const PAD = /controller|gamepad|manette|mando|controle|xbox|dualsense|dualshock|joy-?con|геймпад/i;

// what was plugged in, from the name and the class Windows gives it
function kindOf({ name = '', class: cls = '' }) {
  if (PAD.test(name)) return 'controller';
  if (cls === 'DiskDrive' || cls === 'Volume') return 'drive'; // USB sticks: by their drive letter
  if (cls === 'WPD' || PHONE.test(name)) return 'phone';
  if (cls === 'AudioEndpoint' || cls === 'MEDIA') return 'audio';
  if (cls === 'Camera' || cls === 'Image') return 'camera';
  if (['Keyboard', 'Mouse', 'HIDClass'].includes(cls)) return 'input';
  return 'device';
}

export class Pc {
  constructor({ capri, panel, brain, host, voice, chat, guide }) {
    Object.assign(this, { capri, panel, brain, host, voice, chat, guide });
    this.enabled = true;
    this.gameBehavior = 'stay';
    this.gameDelaySeconds = 30;
    this.gameScope = 'all';
    this.wantsOut = () => true; // not put away in her settings
    this.hotSince = 0;
    this.hot = false;
    this.hotAt = -Infinity;
    this.charging = null;
    this.chargerAt = -Infinity;
    this.warned = 1; // lowest battery level she warned about (1: none yet)
    this.cutOff = false;
    this.drives = null;
    this.plugs = null; // count of plug events seen (windows.ps1)
    this.plugAt = -Infinity;
    this.game = null;
    setInterval(() => this.checkCpu(), 3000);
    setInterval(() => this.checkGame(), 1000);
    this.watchBattery();
    window.addEventListener('offline', () => this.offline());
    window.addEventListener('online', () => this.online());
  }

  get t() {
    return this.brain.t.pc;
  }

  // not in the middle of something that matters more
  get quiet() {
    return this.enabled && !['alert', 'sleep'].includes(this.capri.mode) && !this.capri.dormant
      && !this.capri.stowed && !this.chat.open && !this.guide.running;
  }

  configure(cfg = {}) {
    this.enabled = cfg.pcReact !== false;
    const behavior = ['stay', 'sleep', 'hide'].includes(cfg.gameBehavior)
      ? cfg.gameBehavior : cfg.hideInGames === true ? 'hide' : 'stay';
    const seconds = Number(cfg.gameDelaySeconds);
    const delay = Number.isFinite(seconds) ? Math.max(5, Math.min(300, seconds)) : 30;
    const scope = ['all', 'minecraft', 'ss14'].includes(cfg.gameScope) ? cfg.gameScope : 'all';
    if (behavior !== this.gameBehavior || delay !== this.gameDelaySeconds || scope !== this.gameScope) {
      this.releaseGame(this.game);
      if (this.game) { this.game.since = Date.now(); this.game.said = false; }
    }
    this.gameBehavior = behavior;
    this.gameDelaySeconds = delay;
    this.gameScope = scope;
    if (!this.wantsOut()) this.releaseGame(this.game);
  }

  behaviorFor(game) {
    if (this.gameScope === 'minecraft' && !/minecraft/i.test(game.name)) return 'stay';
    if (this.gameScope === 'ss14' && !/space station 14|ss14/i.test(game.name)) return 'stay';
    return this.gameBehavior || 'stay';
  }

  // A real click or explicit command gives her a minute to help before resting again.
  interact() {
    if (!this.game) return;
    this.game.overrideUntil = Date.now() + 60000;
    this.releaseGame(this.game);
  }

  // Only undo a rest this scheduler started. A manually hidden/asleep character is left alone.
  releaseGame(game, greet = false) {
    if (!game) return;
    const slept = game.sleeping; const hidden = game.put;
    game.sleeping = false; game.put = false;
    if (!this.wantsOut()) return;
    if (slept && !this.capri.stowed && (this.capri.mode === 'sleep' || this.capri.dormant)) this.capri.wake();
    if (hidden && (this.capri.stowed || this.capri.stowing)) {
      Promise.resolve(this.capri.unstow()).then(() => {
        if (greet) this.say(pick(this.t.gameBack), 'look', 5000);
      });
    }
  }

  say(line, face = 'smug', hold = 4500) {
    if (this.quiet) this.panel.say({ kind: 'info', ambient: true, face, line, hold });
  }

  // waits a few seconds for her to be free to move, if she's busy
  async whenFree(ms = 6000) {
    for (let waited = 0; !this.capri.free && waited < ms; waited += 250) await new Promise((r) => setTimeout(r, 250));
    return this.capri.free;
  }

  async checkCpu() {
    if (!this.enabled) return;
    const cpu = await this.host.cpu().catch(() => null);
    if (cpu == null) return;
    const now = Date.now();
    if (cpu < HOT) {
      this.hotSince = 0;
      if (this.hot && cpu < 55) {
        this.hot = false;
        if (!this.panel.visible) this.say(pick(this.t.cool), 'calm', 3000);
      }
      return;
    }
    this.hotSince ||= now;
    if (this.hot || now - this.hotSince < HOT_FOR || now - this.hotAt < HOT_EVERY || !this.quiet) return;
    this.hot = true;
    this.hotAt = now;
    this.capri.wake();
    this.say(fmt(pick(this.t.hot), { cpu }), 'wide', 5000);
    this.voice.play('charge');
    if (await this.whenFree()) this.capri.perform('overheat');
  }

  async watchBattery() {
    const battery = await navigator.getBattery?.().catch(() => null);
    if (!battery) return;
    const changed = () => this.battery(battery);
    battery.addEventListener('levelchange', changed);
    battery.addEventListener('chargingchange', changed);
    this.charging = battery.charging; // as it is when she starts: nothing to say
  }

  async battery({ level, charging }) {
    if (!this.quiet) return;
    const now = Date.now();
    if (charging !== this.charging) {
      this.charging = charging;
      if (now - this.chargerAt > CHARGER_EVERY) {
        this.chargerAt = now;
        if (charging) {
          this.warned = 1;
          this.say(pick(this.t.charging), 'laugh', 3500);
          this.capri.recharge();
        } else {
          this.say(pick(this.t.unplugged), 'aside', 3500);
        }
      }
    }
    if (charging) return;
    const at = level <= 0.05 ? 0.05 : level <= 0.15 ? 0.15 : 1;
    if (at >= this.warned) return;
    this.warned = at;
    this.capri.wake();
    this.say(fmt(pick(at === 0.05 ? this.t.critical : this.t.low), { level: Math.round(level * 100) }), 'aside', 6000);
    if (await this.whenFree()) this.capri.drain();
  }

  offline() {
    clearTimeout(this.offlineTimer);
    // a blip isn't worth it
    this.offlineTimer = setTimeout(() => {
      if (navigator.onLine || !this.quiet) return;
      this.cutOff = true;
      this.voice.play('error');
      this.say(pick(this.t.offline), 'wide', 5000);
      this.capri.hurt();
    }, 4000);
  }

  online() {
    clearTimeout(this.offlineTimer);
    if (!this.cutOff) return;
    this.cutOff = false;
    if (!this.quiet) return;
    this.voice.play('hello');
    this.say(pick(this.t.online), 'laugh', 3500);
    if (this.capri.free) this.capri.perform('hop');
  }

  // what windows.ps1 sees: USB sticks by letter, devices plugged in or out, the game in front
  onWindows({ usb = [], plug = null, game = null }) {
    if (this.enabled && this.drives) {
      const added = usb.find((d) => !this.drives.includes(d));
      const removed = this.drives.find((d) => !usb.includes(d));
      if (added) this.stick(added);
      else if (removed) this.say(pick(this.t.usbOut), 'smug', 3500);
    }
    this.drives = usb;

    if (this.enabled && this.plugs !== null && plug && plug.n !== this.plugs) this.device(plug);
    this.plugs = plug?.n ?? 0;

    const g = this.game;
    if (game) {
      if (g?.name === game) g.gone = 0;
      else {
        this.releaseGame(g);
        this.game = { name: game, since: Date.now(), gone: 0, said: false, put: false, sleeping: false, overrideUntil: 0 };
      }
    } else if (g && !g.gone) {
      g.gone = Date.now();
    }
  }

  // a USB stick: she dives into it to have a look
  async stick(drive) {
    if (!this.quiet) return;
    this.capri.wake();
    this.say(fmt(pick(this.t.usb), { drive }), 'look', 2500);
    if (!this.quiet || !(await this.whenFree())) return;
    const { w, h } = this.capri.view;
    if (await this.capri.visit({ x: w - 140, y: h - 6 })) this.say(pick(this.t.usbBack), 'smug', 4500);
  }

  // anything else plugged in or out: a phone, a controller, a headset...
  device(plug) {
    if (!this.quiet) return;
    const kind = kindOf(plug);
    if (kind === 'drive' || Date.now() - this.plugAt < PLUG_EVERY) return;
    this.plugAt = Date.now();
    const lines = plug.in ? this.t.plugIn : this.t.plugOut;
    this.capri.wake();
    // plugged in: a jolt of lightning down to where it came in (by the clock), before she talks
    if (plug.in && this.capri.free) {
      const { w, h } = this.capri.view;
      this.capri.zap(w - 140, h - 10);
    }
    this.say(fmt(pick(lines[kind] || lines.device), { name: plug.name }), plug.in ? 'look' : 'aside', 4000);
  }

  checkGame() {
    const g = this.game;
    if (!g) return;
    const now = Date.now();
    // A brief Alt+Tab does not cause repeated wake/sleep transitions.
    if (g.gone) {
      if (now - g.gone >= GAME_OVER) {
        this.game = null;
        this.releaseGame(g, true);
      }
      return;
    }
    if (!this.wantsOut()) { this.releaseGame(g); return; }
    // Something else woke her, or the user brought her out: don't immediately put her back.
    if ((g.sleeping && this.capri.mode !== 'sleep' && !this.capri.dormant)
      || (g.put && !this.capri.stowed && !this.capri.stowing)) this.interact();
    const behavior = this.behaviorFor(g);
    if (behavior === 'stay') {
      this.releaseGame(g);
      if (!this.capri.stowed && this.capri.mode !== 'alert') this.capri.wake();
      if (!g.said && now - g.since >= GAME_AFTER && this.quiet) {
        g.said = true;
        this.say(this.brain.lang === 'ja' ? 'ゲーム中もここにいるよ。大事な場面では静かに応援するね。'
          : 'Играешь? Я останусь рядом, чум. Без лишнего шума — но на важные события попробую отреагировать.', 'smug', 4000);
      }
      return;
    }
    if (g.sleeping || g.put || now < (g.overrideUntil || 0) || now - g.since < this.gameDelaySeconds * 1000) return;
    // Never take a conversation, drag, animation, or manually chosen sleep away from the user.
    if (this.chat.open || this.guide.running || this.panel.visible || !this.capri.free || this.capri.mode !== 'idle') return;
    this.onRest?.();
    if (behavior === 'sleep') {
      g.sleeping = true;
      this.capri.setMode('sleep');
    } else {
      g.put = true;
      this.capri.stow();
    }
  }
}
