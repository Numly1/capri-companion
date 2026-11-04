// A short, explicitly requested dance using the original character's acts.
export class CompanionMusicDance {
  constructor({ capri, panel, chat, guide, pc, speech }, options = {}) {
    Object.assign(this, { capri, panel, chat, guide, pc, speech });
    this.reduced = options.reduced || (() => false);
    this.running = false; this.generation = 0; this.ownedAct = null;
  }
  get available() {
    const c = this.capri;
    return !this.running && !this.pc?.game && !this.speech?.pendingSpeech && !this.speech?.playing
      && c.free && c.mode === 'idle' && !c.act && !c.dragging && !c.stowed && !c.hidden && !c.dormant
      && !this.panel.visible && !this.chat.open && !this.guide.running;
  }
  async start() {
    if (!this.available) return false;
    this.running = true;
    const generation = ++this.generation;
    const acts = this.reduced() ? ['look'] : this.capri.stance === 'sit' ? ['curious', 'look', 'curious'] : ['hop', 'spin', 'hop'];
    try {
      for (const name of acts) {
        const c = this.capri;
        if (generation !== this.generation || this.pc?.game || this.speech?.pendingSpeech || this.speech?.playing
          || c.mode !== 'idle' || c.dragging || c.stowed || c.hidden || c.dormant || c.busy || c.act
          || this.panel.visible || this.chat.open || this.guide.running) break;
        const done = c.perform(name, c.towardCenter?.() || 1);
        this.ownedAct = c.act;
        await done;
        this.ownedAct = null;
      }
      return true;
    } finally { this.running = false; this.ownedAct = null; }
  }
  stop() {
    this.generation++;
    if (this.ownedAct && this.capri.act === this.ownedAct) this.capri.endAct(false);
    this.ownedAct = null;
  }
}
