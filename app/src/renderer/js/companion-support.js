// Explicit support requests. Late replies cannot replace a newer card or speak during folding.
export class CompanionSupport {
  constructor({ host, capri, panel, chat, guide, speech }, { now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { host, capri, panel, chat, guide, speech, now, sleep });
    this.turn = 0; this.visible = true; this.disposed = false;
  }
  cancel() { this.turn++; }
  configure(cfg) { this.visible = cfg.visible !== false; if (!this.visible) this.cancel(); }
  async show(category = 'encouragement') {
    const turn = ++this.turn;
    const current = () => !this.disposed && turn === this.turn && !this.capri.visitAway;
    if (!current()) return false;
    this.guide.answer(null); this.chat.close(); this.speech.cancelRecording(); this.speech.stop(); this.panel.hide();
    const baseline = this.panel.current;
    try {
      if (!this.visible || this.capri.stowed || this.capri.stowing) {
        const cfg = await this.host.setConfig({ visible: true });
        if (!current() || cfg?.visible === false) return false;
        this.visible = true;
        await this.capri.unstow();
      }
      if (!current() || !this.visible) return false;
      this.capri.wake();
      const deadline = this.now() + 10000;
      while (this.capri.stowing || this.capri.stowed || this.capri.busy || this.guide.running) {
        if (!current() || !this.visible || this.panel.current !== baseline || this.chat.open || this.now() >= deadline) return false;
        if (!this.capri.stowing && this.capri.stowed) await this.capri.unstow();
        await this.sleep(40);
      }
      const result = await this.host.supportLine(category);
      if (!current() || !this.visible || this.chat.open || this.guide.running || this.capri.stowing || this.capri.stowed
          || this.capri.hidden || this.panel.current !== baseline || !result?.ok || typeof result.line !== 'string' || result.line.length > 600) return false;
      const shown = this.panel.say({ kind: 'info', badge: 'Я РЯДОМ', face: result.face, line: result.line, hold: 10000,
        actions: [{ id: 'more', label: 'Ещё немного поддержки', primary: true }, { id: 'done', label: 'Спасибо' }],
        onAction: id => { if (id === 'more') this.show(category); else this.panel.hide(); } });
      if (shown === false) return false;
      this.speech.say(result.line);
      if (this.capri.free) this.capri.perform(result.action === 'hop' ? 'hop' : 'curious');
      return true;
    } catch { return false; }
  }
  dispose() { this.disposed = true; this.cancel(); }
}
