// Local context reactions are opportunities, never queued work. Busy means skip this one.
export class CompanionContext {
  constructor({ capri, panel, brain, host, chat, guide }) {
    Object.assign(this, { capri, panel, brain, host, chat, guide });
    this.enabled = true;
    this.spotifyEnabled = true;
    this.kritaEnabled = true;
    this.lastReaction = null;
    this.state = null;
    this.removeContext = host.onCompanionContext?.((event) => this.onSnapshot(event));
    this.removeConfig = host.onConfig?.((cfg) => this.configure(cfg));
    host.getConfig?.().then((cfg) => this.configure(cfg)).catch(() => {});
  }

  configure(cfg) {
    this.enabled = cfg.companionContext !== false;
    this.visible = cfg.visible !== false;
    this.spotifyEnabled = cfg.spotifyReactions !== false;
    this.kritaEnabled = cfg.kritaReactions !== false;
  }

  onSnapshot(event) {
    this.state = event?.state || null;
    const reaction = event?.reaction;
    if (!reaction || reaction.id === this.lastReaction) return false;
    // Remember even skipped opportunities so a replay cannot interrupt her later.
    this.lastReaction = reaction.id;
    const feedback = accepted => { if (reaction.kind === 'drawing') this.host.contextReaction?.({ id: reaction.id, accepted }); return accepted; };
    const age = Date.now() - event.state?.updatedAt;
    if (Number.isFinite(age) && (age > 25000 || age < -1000)) return feedback(false);
    if (reaction.kind === 'music' && (!this.spotifyEnabled || event.state?.spotifyEnabled === false)) return feedback(false);
    if (reaction.kind === 'drawing' && (!this.kritaEnabled || event.state?.kritaEnabled === false)) return feedback(false);
    if (!this.enabled || this.visible === false || !event.state?.enabled || !this.capri.free || ['alert', 'sleep'].includes(this.capri.mode) ||
        this.panel.visible || this.chat?.open || this.guide?.running) return feedback(false);
    if (typeof reaction.line !== 'string' || reaction.line.length > 700) return feedback(false);
    const face = ['smug', 'laugh', 'look', 'calm'].includes(reaction.face) ? reaction.face : 'smug';
    const action = ['curious', 'hop', 'look'].includes(reaction.action) ? reaction.action : 'curious';
    this.capri.wake();
    if (this.panel.say({ kind: 'info', face, line: reaction.line, hold: 6000 }) === false) return feedback(false);
    this.onSay?.(reaction.line);
    if (this.capri.free) this.capri.perform(action);
    return feedback(true);
  }

  dispose() { this.removeContext?.(); this.removeConfig?.(); }
}
