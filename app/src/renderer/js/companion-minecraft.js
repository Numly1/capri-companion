// Receives fixed reaction text, never raw Minecraft chat or client credentials.
export class CompanionMinecraft {
  constructor({ host, capri, panel, chat, guide }) {
    Object.assign(this, { host, capri, panel, chat, guide });
    this.enabled = false; this.lastReaction = null; this.state = null;
    this.removeEvent = host.onMinecraft?.(event => this.onSnapshot(event));
    this.removeConfig = host.onConfig?.(cfg => this.configure(cfg));
  }
  configure(cfg) { this.enabled = cfg.minecraftReactions === true; }
  onSnapshot(event) {
    this.state = event?.state || null; const reaction = event?.reaction;
    if (!reaction || reaction.id === this.lastReaction) return false;
    this.lastReaction = reaction.id;
    if (!this.enabled || event.state?.enabled !== true || event.state?.active !== true || reaction.source !== 'client-log'
      || this.chat?.open || this.guide?.running || this.panel.visible || this.capri.hidden || this.capri.stowed
      || this.capri.dormant || this.capri.dragging || this.capri.busy || this.capri.mode === 'alert' || this.capri.mode === 'sleep') return false;
    if (typeof reaction.line !== 'string' || !reaction.line || reaction.line.length > 600) return false;
    if (this.panel.say({ kind: 'info', badge: 'MINECRAFT · ЛОКАЛЬНО', face: reaction.face === 'laugh' ? 'laugh' : 'look', line: reaction.line, hold: 9500 }) === false) return false;
    this.onSay?.(reaction.line); return true;
  }
  dispose() { this.removeEvent?.(); this.removeConfig?.(); }
}
