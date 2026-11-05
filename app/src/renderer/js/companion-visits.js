import { GuestSprite, visitGuest, visitName } from './companion-visit-guest.js';

const CONNECTIONS = ['off', 'listening', 'connecting', 'paired', 'error'];
const invitationCode = value => typeof value === 'string' && value.trim().length <= 1024 && /^capri1\.[A-Za-z0-9_-]{10,1017}$/.test(value.trim()) ? value.trim() : null;
const addressValid = value => typeof value === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part);

export function visitState(value) {
  const raw = value?.state || value || {};
  const paired = raw.paired === true;
  return { listening: raw.listening === true, paired, peerName: visitName(raw.peerName), connection: CONNECTIONS.includes(raw.connection) ? raw.connection : 'off',
    away: paired && raw.away === true, guest: paired ? visitGuest(raw.guest) : null, error: raw.error ? 'Связь прервалась. Капри вернулась домой; можно подключиться заново.' : null };
}

export class CompanionVisits {
  constructor({ host, capri, panel, chat, guide, image, onAwayChange }, options = {}) {
    Object.assign(this, { host, capri, panel, chat, guide, image, onAwayChange });
    this.document = options.document || document;
    this.Guest = options.GuestSprite || GuestSprite;
    this.guestOptions = options.guestOptions || {};
    this.cfg = {}; this.state = visitState(null); this.away = false; this.guest = null; this.guestId = null;
    this.opening = false; this.disposed = false; this.generation = 0; this.invitation = null;
    this.style = this.document.createElement('link'); this.style.rel = 'stylesheet'; this.style.href = 'styles/companion-visits.css'; this.document.head.appendChild(this.style);
    this.removeEvent = host.onVisits?.(state => this.onSnapshot(state));
    this.removeConfig = host.onConfig?.(cfg => this.configure(cfg));
    this.refresh().catch(() => {});
  }

  configure(cfg = {}) { this.cfg = cfg; this.guest?.configure(cfg); }

  async request(action, fields = {}) {
    if (this.disposed || typeof this.host.visitsAction !== 'function') return { ok: false, error: 'Гости пока недоступны в этой версии.' };
    try { return await this.host.visitsAction({ action, ...fields }) || { ok: false }; }
    catch { return { ok: false, error: 'Не удалось связаться с другим компьютером. Проверь Radmin VPN и повтори.' }; }
  }

  async refresh() {
    const generation = this.generation;
    const result = await this.request('state');
    if (!this.disposed && generation === this.generation && result?.ok !== false) this.onSnapshot(result.state || result);
    return this.state;
  }

  onSnapshot(raw) {
    if (this.disposed) return;
    this.generation++;
    const state = visitState(raw);
    this.state = state;
    if (this.away !== state.away) { this.away = state.away; this.onAwayChange?.(this.away); }
    const arrived = state.guest && state.guest.visitId !== this.guestId;
    if (!state.guest || arrived) { this.guest?.dispose(); this.guest = null; this.guestId = state.guest?.visitId || null; }
    if (state.guest) {
      if (!this.guest) {
        try { this.guest = new this.Guest({ image: this.image, guest: state.guest }, this.guestOptions); }
        catch { this.guest = null; }
      } else this.guest.update(state.guest);
      this.guest?.configure(this.cfg);
    }
    // An arrival during a conversation, guide or sleep is consumed, never queued.
    if (arrived && this.cfg.visible !== false && !this.chat?.open && !this.guide?.running && !this.panel.visible && !this.capri.busy && !['sleep', 'alert'].includes(this.capri.mode)) {
      this.panel.say({ kind: 'info', badge: 'В ГОСТЯХ', face: 'laugh', line: `К тебе заглянула ${state.guest.name}! Устраиваем маленькую цифровую тусовку.`, hold: 6500 });
    }
  }

  async open() {
    if (this.opening || this.disposed) return;
    this.opening = true;
    try {
      await this.refresh();
      if (this.disposed) return;
      this.panel.resume?.();
      await this.guide.scene(async () => {
        while (!this.disposed) {
          this.panel.resume?.();
          const state = this.state;
          const action = await this.guide.ask({ face: 'look', badge: 'В ГОСТИ', line: state.paired ? `На связи: ${state.peerName}` : 'Отправим Капри в гости?',
            quote: state.paired ? (state.away ? 'Твоя Капри гостит на другом ПК. Вернуть её можно в любой момент.' : state.guest ? 'На твоём экране сейчас гостья. Твоя Капри остаётся рядом.' : 'Компьютеры соединены. Можно отправить Капри в гости.') : 'Оба компьютера должны быть в одной сети Radmin VPN или одной локальной сети. Подруга тоже запускает Капри. Переписка и API-ключи остаются на своих компьютерах.',
            actions: state.paired ? [{ id: state.away ? 'return' : 'visit', label: state.away ? 'Вернуть домой' : 'Отправить Капри', primary: true }, ...(state.guest && !state.away ? [{ id: 'return', label: 'Проводить гостью' }] : []), { id: 'disconnect', label: 'Завершить связь' }, { id: 'close', label: 'Закрыть' }]
              : [{ id: 'invite', label: 'Пригласить компьютер', primary: true }, { id: 'join', label: 'Подключиться' }, { id: 'close', label: 'Позже' }] });
          if (!action || action === 'close' || this.disposed) return;
          if (action === 'invite') await this.invite();
          else if (action === 'join') await this.join();
          else if (['visit', 'return', 'disconnect'].includes(action)) {
            this.working(action === 'visit' ? 'Капри собирается в гости…' : action === 'return' ? 'Возвращаю Капри домой…' : 'Завершаю связь…');
            const result = await this.request(action, action === 'visit' ? { name: this.localName || 'Капри', mood: this.capri.mode === 'sleep' ? 'sleep' : 'happy', facing: this.capri.facing === -1 ? -1 : 1, scale: Math.max(0.4, Math.min(0.8, Number(this.capri.scale) || 0.6)) } : {});
            if (result.ok === false) await this.failure(result);
            await this.refresh();
          }
        }
      }, { keepStowed: this.away || this.cfg.visible === false });
    } finally { this.invitation = null; this.opening = false; }
  }

  working(line) { if (!this.disposed) this.panel.say({ kind: 'info', badge: 'В ГОСТИ', face: 'look', guide: true, line, hold: null }); }
  async failure(result) {
    if (this.disposed) return;
    const text = typeof result?.error === 'string' ? result.error.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 220) : 'Не получилось подключиться. Проверь Radmin VPN на обоих компьютерах и повтори.';
    await this.guide.ask({ face: 'aside', badge: 'В ГОСТИ', line: 'Связь пока не получилась.', quote: text, actions: [{ id: 'ok', label: 'Понятно', primary: true }] });
  }

  async name() {
    const result = await this.guide.askText({ face: 'look', line: 'Как подписать твою Капри?', quote: 'Это имя увидит подруга. Например: «Капри от Саши». Не больше 24 символов.', placeholder: 'Имя до 24 символов', send: 'Готово', actions: [{ id: 'default', label: 'Просто Капри' }] });
    if (!result || this.disposed) return null;
    this.localName = result.action === 'default' ? 'Капри' : visitName(result.text);
    return this.localName;
  }

  async invite() {
    const result = await this.request('options');
    if (this.disposed) return;
    const options = result.options || result;
    const addresses = Array.isArray(options.addresses) ? options.addresses.filter(item => ['radmin', 'lan'].includes(item?.kind) && addressValid(item.address))
      .sort((a, b) => (a.kind === 'radmin' ? 0 : 1) - (b.kind === 'radmin' ? 0 : 1)).slice(0, 8) : [];
    if (!addresses.length) return this.failure({ error: 'Не нашла адрес Radmin VPN или локальной сети. Включи Radmin VPN и убедись, что оба компьютера находятся в одной сети.' });
    const action = await this.guide.ask({ face: 'look', line: 'Через какую сеть пригласить?', quote: 'Для разных домов выбирай Radmin VPN. В одной квартире можно выбрать локальную сеть.',
      actions: [...addresses.map((item, index) => ({ id: `address:${index}`, label: `${item.kind === 'radmin' ? 'Radmin VPN' : 'Локальная сеть'} · ${item.address}`, primary: index === 0 })), { id: 'cancel', label: 'Назад' }] });
    const index = /^address:([0-7])$/.exec(action || '')?.[1];
    if (this.disposed || index === undefined || !addresses[Number(index)] || !(await this.name())) return;
    this.working('Готовлю приглашение…');
    const invite = await this.request('invite', { address: addresses[Number(index)].address, name: this.localName });
    if (this.disposed) return;
    if (invite.ok === false || !invitationCode(invite.code)) return this.failure(invite);
    this.invitation = invitationCode(invite.code);
    while (!this.disposed) {
      const choice = await this.guide.ask({ face: 'smug', line: 'Приглашение готово.', quote: 'Нажми «Скопировать» и отправь код подруге в своём мессенджере. У неё: меню Капри → «В гости» → «Подключиться». Приглашение действует 10 минут; держи Капри открытой.', actions: [{ id: 'copy', label: 'Скопировать приглашение', primary: true }, { id: 'done', label: 'Готово' }] });
      if (choice !== 'copy' || this.disposed) break;
      const copied = await this.request('copy', { code: this.invitation });
      if (this.disposed) return;
      if (copied.ok === false) { await this.failure(copied); break; }
      await this.guide.ask({ face: 'laugh', line: 'Код скопирован. Передай его подруге.', quote: 'Приложение само никому ничего не отправляет. После подключения здесь появится кнопка «Отправить Капри».', actions: [{ id: 'ok', label: 'Понятно', primary: true }] });
      break;
    }
    this.invitation = null; await this.refresh();
  }

  async join() {
    const value = await this.guide.askText({ face: 'look', line: 'Вставь приглашение от другого компьютера.', quote: 'Код начинается с capri1. Оба компьютера должны быть в одной сети Radmin VPN или локальной сети.', secret: true, placeholder: 'Приглашение capri1.…', send: 'Подключиться', actions: [{ id: 'cancel', label: 'Назад' }] });
    if (!value || value.action || this.disposed) return;
    const code = invitationCode(value.text);
    if (!code) return this.failure({ error: 'Это не приглашение Капри. Скопируй код целиком, без ссылки или лишнего текста.' });
    if (!(await this.name())) return;
    this.working('Соединяю компьютеры…');
    const result = await this.request('join', { code, name: this.localName });
    if (result.ok === false) await this.failure(result);
    await this.refresh();
  }

  dispose({ restoreAway = true } = {}) {
    if (this.disposed) return;
    this.disposed = true; this.invitation = null;
    this.removeEvent?.(); this.removeConfig?.(); this.guest?.dispose(); this.guest = null;
    this.style.remove();
    if (this.opening) this.guide.answer?.(null);
    if (this.away) { this.away = false; if (restoreAway) this.onAwayChange?.(false); }
  }
}

export { invitationCode, addressValid };
