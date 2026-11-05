'use strict';

const visits = require('./companion-visits');
const OFF = Object.freeze({ listening: false, endpoint: null, paired: false, peerName: null, connection: 'off', away: false, guest: null, error: null, inviteExpiresAt: null });
const fields = { state: [], options: [], invite: ['address', 'name'], join: ['code', 'name'], visit: ['name', 'mood', 'facing', 'scale'], return: [], disconnect: [], copy: ['code'] };
const failure = error => ({ ok: false, error });

// Keeps invitation secrets in memory and gives the renderer one bounded IPC surface.
function create({ createService = visits.create, onState = () => {}, clipboardWrite = () => {}, now = Date.now } = {}) {
  let service = null, issued = null, generation = 0, busy = false, stopped = false;
  function snapshot(state) {
    if (state.paired || !state.listening || state.inviteExpiresAt !== issued?.expiresAt || issued?.expiresAt <= now()) issued = null;
    onState(state);
  }
  function current() {
    if (!service) {
      const epoch = generation;
      service = createService({ onState: state => { if (epoch === generation) snapshot(state); } });
    }
    return service;
  }
  const getState = () => service?.getState() || { ...OFF };
  async function disconnect() {
    generation++; issued = null; busy = false;
    const previous = service; service = null;
    // Closing the listener also cancels pending joins and transfers.
    await previous?.stop();
    onState(getState());
    return { ok: true };
  }
  async function action(request) {
    if (stopped) return failure('Визиты выключены. Запусти Капри заново.');
    if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(fields, request.action)
        || Object.keys(request).some(key => key !== 'action' && !fields[request.action].includes(key))) return failure('Неизвестная команда визита.');
    const { action } = request;
    if (action === 'state') return { ok: true, state: getState() };
    if (action === 'options') return { ok: true, options: current().getOptions() };
    if (action === 'disconnect') return disconnect();
    if (action === 'return') return service ? service.returnHome() : { ok: true };
    if (action === 'copy') {
      const state = getState();
      if (!issued || typeof request.code !== 'string' || request.code !== issued.code || issued.expiresAt <= now()
          || !state.listening || state.paired || state.inviteExpiresAt !== issued.expiresAt) return failure('Приглашение истекло или отменено. Создай новое.');
      clipboardWrite(issued.code); return { ok: true };
    }
    if (busy) return failure('Подожди, подключение или визит ещё не завершены.');
    if (['invite', 'join'].includes(action) && (typeof request.name !== 'string' || [...request.name].length > 24 || request.name.length > 96)) return failure('Укажи имя Капри до 24 символов.');
    if (action === 'invite' && (typeof request.address !== 'string' || request.address.length > 15)) return failure('Выбери адрес локальной сети или Radmin VPN.');
    if (action === 'join' && (typeof request.code !== 'string' || request.code.length > 1024)) return failure('Скопируй приглашение целиком.');
    const pet = action === 'visit' ? { name: request.name, mood: request.mood, facing: request.facing, scale: request.scale } : null;
    if (pet && !visits.validPet(pet)) return failure('Параметры Капри не подходят для визита.');
    busy = true;
    const epoch = generation;
    try {
      const active = current();
      if (action === 'invite' || action === 'join') issued = null;
      const result = action === 'invite' ? await active.invite({ address: request.address, name: request.name })
        : action === 'join' ? await active.join(request.code, { name: request.name }) : await active.visit(pet);
      if (epoch !== generation || stopped) return failure('Соединение отменено. Капри дома.');
      if (action === 'invite' && result.ok && typeof result.code === 'string' && result.code.length <= 1024 && result.expiresAt > now()) issued = { code: result.code, expiresAt: result.expiresAt };
      return result;
    } catch { return failure('Не удалось подключиться. Проверь Radmin VPN и повтори.'); }
    finally { if (epoch === generation) busy = false; }
  }
  return { action, getState, async stop() { stopped = true; await disconnect(); } };
}

module.exports = { create };
