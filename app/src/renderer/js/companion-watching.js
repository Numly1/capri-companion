export class CompanionWatching {
  constructor({ host, capri, panel, chat, guide, pc }) {
    Object.assign(this, { host, capri, panel, chat, guide, pc });
    this.last = null;
    this.remove = host.onWatching?.(event => this.onSnapshot(event));
  }
  onSnapshot(event) {
    const reaction = event?.reaction;
    if (!reaction || reaction.id === this.last) return false;
    this.last = reaction.id;
    if (!event.state?.enabled || event.state?.watching?.playing !== true || reaction.source !== 'local-metadata'
      || this.chat.open || this.guide.running || this.panel.visible || this.pc.game || !this.capri.free
      || this.capri.stowed || this.capri.dormant || ['sleep', 'alert'].includes(this.capri.mode)) return false;
    if (typeof reaction.line !== 'string' || reaction.line.length > 500) return false;
    const accepted = this.panel.say({ kind: 'info', badge: 'СМОТРИМ ВМЕСТЕ', face: 'smug', line: reaction.line, hold: 8500 }) !== false;
    if (accepted) this.onSay?.(reaction.line);
    return accepted;
  }
  dispose() { this.remove?.(); }
}
