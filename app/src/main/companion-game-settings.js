'use strict';

const GAME_DEFAULTS = Object.freeze({ gameBehavior: 'stay', gameDelaySeconds: 30, gameScope: 'all' });

function normalizeGameSettings(value = {}) {
  const gameBehavior = ['stay', 'sleep', 'hide'].includes(value.gameBehavior)
    ? value.gameBehavior : value.hideInGames === true ? 'hide' : GAME_DEFAULTS.gameBehavior;
  const gameDelaySeconds = typeof value.gameDelaySeconds === 'number' && Number.isFinite(value.gameDelaySeconds)
    ? Math.max(5, Math.min(300, Math.round(value.gameDelaySeconds))) : GAME_DEFAULTS.gameDelaySeconds;
  const gameScope = ['all', 'minecraft', 'ss14'].includes(value.gameScope) ? value.gameScope : GAME_DEFAULTS.gameScope;
  return { gameBehavior, gameDelaySeconds, gameScope, hideInGames: gameBehavior === 'hide' };
}

module.exports = { GAME_DEFAULTS, normalizeGameSettings };
