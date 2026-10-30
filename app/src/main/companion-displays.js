'use strict';

// The preferred ID stays in the profile even while its monitor is unplugged.
// A temporary fallback therefore never changes the monitor she returns to.
function resolveDisplay(all, primaryId, preferredId) {
  return all.find(display => display.id === preferredId)
    || all.find(display => display.id === primaryId) || all[0] || null;
}

function pinPatch(all, id) {
  return all.some(display => display.id === id) ? { displayId: id, follow: false } : null;
}

function mayMove(cfg, all, primaryId, id) {
  if (!all.some(display => display.id === id)) return false;
  return cfg.follow !== false || resolveDisplay(all, primaryId, cfg.displayId)?.id === id;
}

module.exports = { resolveDisplay, pinPatch, mayMove };
