// Speech is opt-in per recording. Output uses local Windows or optional reference-based voices.
const volumeOf = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0.7;
export function nextVoiceStyle(cfg = {}) {
  // Old imported references remain in the advanced menu, never in the everyday cycle.
  const styles = [...(cfg.capriVoiceAvailable ? ['capri-sample'] : []), 'capri', 'bright', 'natural'];
  return styles[(styles.indexOf(cfg.voiceStyle || 'capri') + 1) % styles.length];
}
export class CompanionSpeech {
  constructor({ host, panel, chat, brain }) {
    this.host = host; this.panel = panel; this.chat = chat; this.brain = brain;
    this.cfg = { offlineChat: true, companionVoice: true, responseLanguage: 'ru', voiceStyle: 'capri', volume: 0.7 };
    this.recorder = null; this.stream = null; this.processing = false; this.cancelled = false;
    this.generation = 0; this.speechTurn = 0;
    this.button = document.createElement('button');
    this.button.type = 'button'; this.button.className = 'panel__send companion__mic';
    this.button.textContent = '🎙'; this.button.title = 'Записать голосовое сообщение';
    this.button.setAttribute('aria-label', 'Записать голосовое сообщение');
    this.button.style.cssText = 'flex:0 0 auto;min-width:36px;padding:5px 8px;';
    panel.chatForm.insertBefore(this.button, panel.chatSend);
    this.voiceButton = document.createElement('button');
    this.voiceButton.type = 'button'; this.voiceButton.className = 'panel__action companion__voice';
    this.voiceButton.textContent = 'Голос'; this.voiceButton.title = 'Сменить звучание. Язык ответа не изменится.';
    panel.chatForm.insertBefore(this.voiceButton, panel.chatClose);
    this.voiceButton.addEventListener('click', async (event) => {
      event.preventDefault(); event.stopPropagation();
      if (!this.chat.open || this.panel.chatInput.type === 'password') return;
      const voiceStyle = nextVoiceStyle(this.cfg);
      this.configure(await host.setConfig({ voiceStyle }));
      this.note(`Голос: ${{ 'capri-sample': 'Капри · пробный', capri: 'цифровой', bright: 'звонкий', natural: 'обычный', reference: 'по образцу' }[voiceStyle]}. Язык тот же.`);
      this.say(this.cfg.responseLanguage === 'ja' ? '声を変えたよ。話す言語はそのまま。' : voiceStyle === 'capri-sample' ? 'Мы рядом. Продолжай, художница.' : 'Меняем голос, а я всё ещё Капри. Ну что, так лучше?');
    });
    this.status = document.createElement('div');
    this.status.className = 'companion__speech-status'; this.status.setAttribute('role', 'status');
    this.status.style.cssText = 'font:11px/1.4 sans-serif;color:#b4e6d6;margin:5px 12px 0;max-width:340px;';
    this.status.hidden = true; panel.chatForm.insertAdjacentElement('afterend', this.status);
    this.caption = document.createElement('div');
    this.caption.className = 'companion__speech-caption';
    this.caption.style.cssText = 'font:12px/1.45 sans-serif;color:#e8dcff;margin:4px 12px 8px;max-height:8em;overflow:auto;white-space:pre-wrap;';
    this.caption.hidden = true; this.status.insertAdjacentElement('afterend', this.caption);
    this.button.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (this.recorder?.state === 'recording') this.finish(); else this.record();
    });
    panel.chatClose?.addEventListener('click', () => { this.cancelRecording(); this.stop(); });
    window.addEventListener('beforeunload', () => { this.cancelRecording(); this.stop(); });
  }

  configure(cfg) {
    const changed = (cfg.responseLanguage && cfg.responseLanguage !== this.cfg.responseLanguage) || (cfg.voiceStyle && cfg.voiceStyle !== this.cfg.voiceStyle);
    this.cfg = { ...this.cfg, ...cfg };
    const names = { 'capri-sample': 'Капри · выбранный пробный голос', reference: 'старый эксперимент по образцу', capri: 'цифровой Windows', bright: 'звонкий Windows', natural: 'обычный Windows' };
    if (this.voiceButton) this.voiceButton.title = `Сейчас: ${names[this.cfg.voiceStyle] || 'Windows'}. Нажми, чтобы сменить звучание. Язык ответа не изменится.`;
    if (!this.cfg.companionVoice || this.cfg.muted || volumeOf(this.cfg.volume) === 0 || this.cfg.visible === false || changed) this.stop();
    if (this.cfg.offlineChat) this.cancelRecording();
  }

  note(text) { this.status.textContent = text; this.status.hidden = !text; }

  async record() {
    if (this.processing || this.panel.chatInput.disabled) return;
    if (!this.chat.open || !this.panel.visible || this.panel.chatForm.hidden || this.panel.chatInput.type === 'password') {
      this.note('Открой обычный диалог, чтобы использовать микрофон.'); return;
    }
    if (this.cfg.offlineChat) { this.note('Для микрофона включи ИИ и добавь ключ Groq в настройках. Текст работает без ключа.'); return; }
    if (!['groq', 'openai', 'custom'].includes(this.cfg.provider)) {
      this.note('Голосовой ввод доступен с Groq, OpenAI или совместимым сервисом.'); return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !this.host.transcribeSpeech) {
      this.note('Запись микрофона здесь недоступна. Используй текстовый ввод.'); return;
    }
    this.stop(); this.processing = true; this.button.disabled = true;
    const generation = ++this.generation;
    const chatContext = this.panel.current;
    const current = () => generation === this.generation && !this.cfg.offlineChat && this.chat.open
      && this.panel.visible && !this.panel.chatForm.hidden && this.panel.current === chatContext
      && !this.panel.chatInput.disabled && this.panel.chatInput.type !== 'password';
    this.note('Разреши доступ к микрофону, чтобы записать сообщение.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream; this.cancelled = false;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
      this.recorder = recorder;
      const chunks = []; let size = 0; let limitTimer;
      recorder.ondataavailable = (event) => {
        if (generation !== this.generation) return;
        if (!event.data?.size) return;
        size += event.data.size;
        if (size > 8 * 1024 * 1024) { this.cancelRecording(); this.note('Запись слишком большая. Попробуй более короткую фразу.'); return; }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (generation !== this.generation) return;
        this.cancelRecording(); this.note('Ошибка записи микрофона. Проверь устройство и разрешения Windows.');
      };
      recorder.onstop = async () => {
        clearTimeout(limitTimer); stream.getTracks().forEach((track) => track.stop());
        if (generation !== this.generation) return;
        if (this.recorder === recorder) { this.recorder = null; this.stream = null; this.button.textContent = '🎙'; }
        if (this.cancelled || !current()) { this.processing = false; this.button.disabled = false; return; }
        this.processing = true; this.button.disabled = true; this.note('Распознаю речь…');
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          if (!blob.size || blob.size > 8 * 1024 * 1024) throw new Error('size');
          const audio = Array.from(new Uint8Array(await blob.arrayBuffer()));
          if (!current()) return;
          const result = await this.host.transcribeSpeech({ audio, mime: blob.type, language: this.cfg.responseLanguage });
          if (!current()) return;
          if (result?.ok && typeof result.text === 'string') {
            this.panel.chatInput.value = result.text; this.panel.chatInput.focus();
            this.note('Проверь текст и нажми отправку.');
          } else this.note(result?.error || 'Не удалось распознать речь. Попробуй ещё раз.');
        } catch { if (current()) this.note('Не удалось распознать запись. Текстовый ввод остаётся доступен.'); }
        finally { if (generation === this.generation) { this.processing = false; this.button.disabled = false; } }
      };
      recorder.start(1000); this.button.textContent = '■';
      this.note('Записываю… нажми ■, когда закончишь (до 60 секунд).');
      this.limit = limitTimer = setTimeout(() => this.finish(), 60000);
    } catch {
      if (generation === this.generation) {
        this.cancelRecording(); this.note('Микрофон недоступен. Проверь разрешение для приложения и устройство ввода Windows.');
      }
    }
    finally {
      if (generation === this.generation && this.recorder?.state !== 'inactive') { this.processing = false; this.button.disabled = false; }
    }
  }

  finish() {
    if (this.recorder?.state === 'recording') {
      clearTimeout(this.limit); this.processing = true; this.button.disabled = true; this.recorder.stop();
    }
  }

  cancelRecording() {
    this.generation++;
    this.cancelled = true; clearTimeout(this.limit);
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch { }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null; this.recorder = null; this.processing = false;
    this.button.disabled = false; this.button.textContent = '🎙';
  }

  async say(text) {
    if (!this.cfg.companionVoice || this.cfg.muted || volumeOf(this.cfg.volume) === 0 || !text?.trim()) return;
    this.lastSpeechAt = this.now?.() ?? Date.now();
    if (this.host.synthesizeSpeech) return this.sayDigital(text);
    return this.sayNative(text);
  }

  // Ambient opportunities are dropped, never queued. A conversation or another
  // voice line always has priority over chatter while she wanders around.
  sayAmbient(text) {
    const now = this.now?.() ?? Date.now();
    if (this.cfg.ambientSpeech === false || !this.cfg.companionVoice || this.cfg.muted
        || volumeOf(this.cfg.volume) === 0 || this.chat?.open || this.processing
        || this.recorder?.state === 'recording' || this.pendingSpeech || this.playing
        || typeof text !== 'string' || !text.trim() || text.length > 500
        || text === this.lastAmbientLine || now - (this.lastSpeechAt ?? -Infinity) < 45000) return false;
    this.lastAmbientLine = text;
    this.say(text);
    return true;
  }

  beginSpeech(text) {
    this.stop();
    if (!this.cfg.companionVoice || this.cfg.muted || this.cfg.visible === false || volumeOf(this.cfg.volume) === 0) return null;
    if (this.panel?.current?.chat?.secret) return null;
    if (this.panel?.reserveSpeech && (!this.panel.current || !this.panel.visible)) {
      if (this.panel.say({ kind: 'info', badge: 'ГОЛОС', face: 'look', line: text, hold: 6000 }) === false) return null;
    }
    const session = { turn: this.speechTurn, text };
    if (this.panel?.reserveSpeech) {
      session.lease = this.panel.reserveSpeech(() => { if (this.speechSession === session) this.stop(); }, text);
      if (!session.lease) return null;
    }
    this.speechSession = session;
    this.pendingSpeech = true;
    this.onActivity?.(true);
    this.note('Готовлю голос… Текст уже доступен.');
    return session;
  }

  currentSpeech(session) {
    return this.speechSession === session && session.turn === this.speechTurn && this.cfg.companionVoice
      && !this.cfg.muted && this.cfg.visible !== false && (!session.lease || this.panel.isSpeechCurrent(session.lease));
  }

  startSpeech(session, text, note = '') {
    if (!this.currentSpeech(session)) return false;
    this.pendingSpeech = false; this.playing = true;
    if (this.caption) { this.caption.textContent = text; this.caption.hidden = false; }
    this.note(note ? `Говорю · ${note}` : 'Говорю');
    this.panel?.setSpeechPlaying?.(session.lease, true);
    this.onPlayback?.(true);
    return true;
  }

  finishSpeech(session, note = '') {
    if (!this.currentSpeech(session)) return;
    this.speechSession = null;
    this.pendingSpeech = false; this.playing = false;
    if (this.caption) { this.caption.hidden = true; this.caption.textContent = ''; }
    this.onPlayback?.(false);
    this.onActivity?.(false);
    this.panel?.releaseSpeech?.(session.lease);
    this.note(note);
  }

  async sayNative(text) {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) { this.note('Озвучивание Windows недоступно. Ответ остаётся текстом.'); return; }
    const session = this.beginSpeech(text);
    if (!session) return;
    let voices = synth.getVoices();
    if (!voices.length) { await new Promise((resolve) => setTimeout(resolve, 700)); voices = synth.getVoices(); }
    if (!this.currentSpeech(session)) return;
    const language = this.cfg.responseLanguage === 'ja' ? 'ja' : 'ru';
    const matching = voices.filter((voice) => voice.localService === true && voice.lang?.toLowerCase().startsWith(language));
    const voice = matching.find((item) => /irina|haruka|ayumi|nanami|female/i.test(item.name)) || matching[0];
    if (!voice) {
      this.finishSpeech(session, language === 'ja' ? 'Японский голос Windows не установлен. Добавь его в параметрах языка; ответ остаётся текстом.'
        : 'Русский голос Windows не установлен. Добавь его в параметрах языка; ответ остаётся текстом.');
      return;
    }
    const spokenText = text.replace(/[*_`#]/g, '').trim().slice(0, 4000);
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = this.cfg.voiceStyle === 'natural' ? 1 : 1.04; utterance.pitch = this.cfg.voiceStyle === 'natural' ? 1 : this.cfg.voiceStyle === 'bright' ? 1.35 : 1.18;
    utterance.volume = volumeOf(this.cfg.volume);
    utterance.onstart = () => this.startSpeech(session, spokenText);
    utterance.onend = () => this.finishSpeech(session);
    utterance.onerror = (event) => {
      this.finishSpeech(session, ['canceled', 'interrupted'].includes(event.error) ? '' : 'Не удалось озвучить ответ. Текст остаётся доступен.');
    };
    try { synth.speak(utterance); }
    catch { this.finishSpeech(session, 'Не удалось озвучить ответ. Текст остаётся доступен.'); }
  }

  async sayDigital(text) {
    const session = this.beginSpeech(text);
    if (!session) return;
    try {
      const result = await this.host.synthesizeSpeech({ text });
      if (!this.currentSpeech(session)) return;
      if (!result?.ok) {
        if (result?.keepSelectedVoice || this.cfg.voiceStyle === 'capri-sample') {
          this.finishSpeech(session, result?.error || 'Голос Капри сейчас недоступен. Ответ остаётся текстом.');
          return;
        }
        await this.sayNative(text); return;
      }
      const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
      this.audioContext ||= new AudioContext();
      const ctx = this.audioContext;
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      if (!this.currentSpeech(session)) return;
      await ctx.resume();
      if (!this.currentSpeech(session)) return;
      const output = ctx.createGain();
      output.gain.value = volumeOf(this.cfg.volume);
      const highpass = ctx.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 115;
      const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -18; compressor.ratio.value = 3;
      const input = result.engine === 'reference' ? output : highpass;
      if (input !== output) highpass.connect(compressor).connect(output);
      output.connect(ctx.destination);
      this.audioNodes = [];
      this.audioGraph = [highpass, compressor, output];
      const digital = result.engine !== 'reference' && this.cfg.voiceStyle !== 'natural' && this.cfg.digitalVoice !== false;
      // One clear voice and two quiet, slightly detuned echoes: a playful digital chorus.
      const layers = digital ? [[0, 0, 0.82], [-9, 0.014, 0.09], [11, 0.023, 0.09]] : [[0, 0, 1]];
      let remaining = layers.length;
      const now = ctx.currentTime;
      const spokenText = typeof result.spokenText === 'string' ? result.spokenText : text.replace(/[*_`#]/g, '').trim().slice(0, 1200);
      for (const [cents, delay, volume] of layers) {
        const source = ctx.createBufferSource(); source.buffer = buffer;
        source.playbackRate.value = digital ? (this.cfg.voiceStyle === 'bright' ? 1.19 : 1.09) : 1;
        source.detune.value = cents;
        const gain = ctx.createGain(); gain.gain.value = volume;
        source.connect(gain).connect(input);
        this.audioNodes.push(source);
        source.onended = () => {
          source.disconnect(); gain.disconnect();
          if (--remaining === 0) {
            highpass.disconnect(); compressor.disconnect(); output.disconnect();
            if (this.currentSpeech(session)) { this.audioNodes = []; this.audioGraph = []; this.finishSpeech(session); }
          }
        };
        source.start(now + delay);
      }
      this.startSpeech(session, spokenText, result.excerpt ? 'озвучиваю начало ответа; полный текст выше' : result.voiceNote || result.fallbackNote || '');
    } catch {
      if (this.currentSpeech(session)) { this.stop(); this.note('Не удалось воспроизвести голос. Ответ остаётся текстом.'); }
    }
  }

  stop() {
    const session = this.speechSession;
    this.speechSession = null;
    this.speechTurn++;
    this.pendingSpeech = false; this.playing = false;
    window.speechSynthesis?.cancel();
    for (const source of this.audioNodes || []) { try { source.stop(); } catch { } }
    this.audioNodes = [];
    for (const node of this.audioGraph || []) { try { node.disconnect(); } catch { } }
    this.audioGraph = [];
    if (this.caption) { this.caption.hidden = true; this.caption.textContent = ''; }
    this.onPlayback?.(false);
    this.onActivity?.(false);
    if (session?.lease) this.panel?.releaseSpeech?.(session.lease);
    if (session) this.note('');
  }
}
