const { originalNeedsPreview } = require('../utils/rawFormats');

// #756: a NULL per-event hero_logo_visible means "inherit the global
// branding_logo_display_hero toggle". Only an explicit true/false is a
// per-gallery override. `globalDefault` is branding_logo_display_hero
// (defaults true when unset).
function resolveHeroLogoVisible(perEvent, globalDefault) {
  if (perEvent === null || perEvent === undefined) {
    return globalDefault !== false;
  }
  return perEvent !== false && perEvent !== 0 && perEvent !== '0';
}

module.exports = { resolveHeroLogoVisible, originalNeedsPreview };

