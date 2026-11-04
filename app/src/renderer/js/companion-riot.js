// Fixed local event reactions only; no player names, screen text or API payloads.
export class CompanionRiot {
  constructor({ host, capri, panel, chat, guide }) {
    Object.assign(this, { host, capri, panel, chat, guide });
    this.cfg = {}; this.lastReaction = null; this.state = null;
    this.removeEvent = host.onRiot?.(event => this.onSnapshot(event));
    this.removeConfig = host.onConfig?.(cfg => this.configure(cfg));
  }
  configure(cfg = {}) { this.cfg = cfg; }
  onSnapshot(event) {
    this.state = event?.state || null;
    const reaction = event?.reaction;
    if (!reaction || reaction.id === this.lastReaction) return false;
    this.lastReaction = reaction.id;
    const game = reaction.game;
    if (!['valorant', 'lol'].includes(game) || this.cfg[game === 'valorant' ? 'valorantReactions' : 'lolReactions'] !== true || event.state?.enabled !== true || event.state?.active !== true || event.state?.game !== game || reaction.source !== (game === 'valorant' ? 'local-screen' : 'lol-live-client')
      || this.chat?.open || this.guide?.running || this.panel.visible || this.capri.hidden || this.capri.stowed || this.capri.dormant || this.capri.dragging || this.capri.busy || ['sleep', 'alert'].includes(this.capri.mode)) return false;
    if (typeof reaction.line !== 'string' || !reaction.line || reaction.line.length > 600) return false;
    if (this.panel.say({ kind: 'info', badge: `${game === 'valorant' ? 'VALORANT' : 'LOL'} · ЛОКАЛЬНО`, face: reaction.face === 'laugh' ? 'laugh' : 'look', line: reaction.line, hold: 8500 }) === false) return false;
    this.onSay?.(reaction.line); return true;
  }
  dispose() { this.removeEvent?.(); this.removeConfig?.(); }
}
