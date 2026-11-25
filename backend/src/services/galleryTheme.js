/**
 * Which look a gallery renders with.
 *
 * Gallery layout, header style, controls style, colours, fonts, the CSS
 * template and custom CSS are global: they live in the Branding theme
 * (app_settings.theme_config, the CSS template as its `cssTemplateId`). A
 * gallery overrides all of them at once by switching on
 * `events.custom_theme_enabled`; its own `color_theme` and `css_template_id`
 * then apply. Switching it off keeps those columns, so switching it on again
 * restores the gallery's own look.
 *
 * Every public payload that carries a gallery's theme goes through
 * publicThemeFields, so the frontend keeps its single rule "no color_theme =
 * use the Branding theme".
 */
const { db } = require('../database/db');
const { parseBooleanInput } = require('../utils/parsers');

const DEFAULT_HEADER_STYLE = 'standard';
const DEFAULT_HERO_DIVIDER_STYLE = 'wave';

/**
 * Whether the gallery uses its own theme. Every row has custom_theme_enabled
 * since migration 259; a caller whose select leaves the column out (no key
 * on the row) keeps the old rule: any stored theme or CSS template is the
 * gallery's own.
 */
function usesCustomTheme(event) {
  if (!event) return false;
  if (event.custom_theme_enabled === undefined) {
    return Boolean(event.color_theme) || event.css_template_id != null;
  }
  return parseBooleanInput(event.custom_theme_enabled, false);
}

async function loadBrandingTheme(knex = db) {
  const row = await knex('app_settings').where({ setting_key: 'theme_config' }).first('setting_value');
  if (!row || row.setting_value == null) return null;
  if (typeof row.setting_value === 'object') return row.setting_value;
  try {
    const parsed = JSON.parse(row.setting_value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * The theme fields a public gallery payload carries for `event`.
 * @param {object} event  events row (color_theme, header_style, hero_divider_style, custom_theme_enabled)
 * @param {object|null} [brandingTheme]  pass when already loaded, to skip the read
 */
async function publicThemeFields(event, brandingTheme) {
  if (usesCustomTheme(event)) {
    return {
      color_theme: event.color_theme || null,
      header_style: event.header_style || DEFAULT_HEADER_STYLE,
      hero_divider_style: event.hero_divider_style || DEFAULT_HERO_DIVIDER_STYLE,
    };
  }
  const branding = brandingTheme === undefined ? await loadBrandingTheme() : brandingTheme;
  return {
    color_theme: null,
    header_style: branding?.headerStyle || DEFAULT_HEADER_STYLE,
    hero_divider_style: branding?.heroDividerStyle || DEFAULT_HERO_DIVIDER_STYLE,
  };
}

/** The CSS template id that applies to the gallery, or null. */
async function effectiveCssTemplateId(event, brandingTheme) {
  if (usesCustomTheme(event)) return event.css_template_id ?? null;
  const branding = brandingTheme === undefined ? await loadBrandingTheme() : brandingTheme;
  const id = Number(branding?.cssTemplateId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = {
  usesCustomTheme,
  loadBrandingTheme,
  publicThemeFields,
  effectiveCssTemplateId,
};
