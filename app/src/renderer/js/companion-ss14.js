// A fixed local reaction only: OCR/chat contents never enter the renderer or model history.
export class CompanionSS14 {
  constructor({ host, capri, panel, chat, guide }) {
    Object.assign(this, { host, capri, panel, chat, guide });
    this.enabled = true; this.lastReaction = null; this.state = null;
    this.removeEvent = host.onSs14?.(event => this.onSnapshot(event));
    this.removeConfig = host.onConfig?.(cfg => this.configure(cfg));
  }

  configure(cfg) { this.enabled = cfg.ss14Reactions === true; }

  onSnapshot(event) {
    this.state = event?.state || null;
    const reaction = event?.reaction;
    if (!reaction || reaction.id === this.lastReaction) return false;
    this.lastReaction = reaction.id;
    if (!this.enabled || event.state?.enabled !== true || event.state?.active !== true || reaction.source !== 'local-screen'
      || this.chat?.open || this.guide?.running || this.panel.visible || this.capri.hidden || this.capri.stowed
      || this.capri.dormant || this.capri.dragging || this.capri.busy || this.capri.mode === 'alert' || this.capri.mode === 'sleep') return false;
    if (typeof reaction.line !== 'string' || !reaction.line || reaction.line.length > 600) return false;
    const shown = this.panel.say({ kind: 'info', badge: 'SS14 · ЛОКАЛЬНО', face: reaction.face === 'laugh' ? 'laugh' : 'look', line: reaction.line, hold: 10000 });
    if (shown === false) return false;
    this.onSay?.(reaction.line);
    // Do not trigger a large movement over the game while its messages are important.
    return true;
  }

  dispose() { this.removeEvent?.(); this.removeConfig?.(); }
}
