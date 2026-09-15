'use strict';

/**
 * Example catalogue entries (#1451): services, a package, two promotions,
 * text blocks and a template, so a new install shows how each part works.
 *
 * The services, package, promotions and text blocks are archived: the quote
 * editor doesn't offer them, the catalogue lists them, and they can be edited
 * and restored like any other entry. The template is an unpublished draft
 * with its own lines and texts: it can be edited, and published and used
 * straight away. Every name starts with "Beispiel:" / "Example:".
 *
 * Seeded once per install (app setting `quote_catalog_examples_seeded`), the
 * first time the catalogue is opened, in the business's language (German
 * unless it is English). Nothing here runs again: an update never adds a
 * second set, never overwrites an edited example and never brings back a
 * deleted one. The payment terms are an example, not advice.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting, upsertAppSetting } = require('../utils/appSettings');
const { formatBoolean } = require('../utils/dbCompat');

const SETTING = 'quote_catalog_examples_seeded';

const EXAMPLES = {
  de: {
    services: {
      hourly: {
        name: 'Beispiel: Fotografie (Stundensatz)', description: 'Fotografie vor Ort', unit: 'hour', price_mode: 'hour',
        unit_price_minor: 0, category: 'Fotografie',
        details_text: 'Der Preis kommt aus dem Stundensatz des Kunden oder aus Ihrem Standardsatz.',
      },
      editing: {
        name: 'Beispiel: Bildbearbeitung', description: 'Bildbearbeitung pro Bild', unit: 'piece', unit_price_minor: 800,
        category: 'Nachbearbeitung', details_text: 'Auswahl, Farb- und Belichtungskorrektur.',
      },
      travel: {
        name: 'Beispiel: Anfahrt', description: 'Anfahrt pro km', unit: 'km', unit_price_minor: 70, category: 'Spesen',
      },
      drone: {
        name: 'Beispiel: Drohnenaufnahmen', description: 'Drohnenaufnahmen', unit: 'flat', unit_price_minor: 25000,
        category: 'Fotografie',
      },
      album: {
        name: 'Beispiel: Fotobuch 30×30 cm', description: 'Fotobuch 30×30 cm, 40 Seiten', unit: 'piece',
        unit_price_minor: 39000, category: 'Produkte',
      },
    },
    package: {
      name: 'Beispiel: Hochzeit Basic',
      description: 'Fotografie nach Stunden, Bildbearbeitung und Anfahrt. Die Stunden kommen aus dem Angebot.',
    },
    club: { name: 'Beispiel: Vereinsrabatt', description: 'Für Mitglieder unseres Partnervereins. Ohne Enddatum.' },
    early: { name: 'Beispiel: Frühbucherrabatt', description: 'Gilt für Buchungen bis Ende nächsten Jahres.' },
    intro: {
      name: 'Beispiel: Einleitung Hochzeit',
      body: 'Liebe/r {{customer_name}}\n\nvielen Dank für Ihre Anfrage für {{event_name}} am {{event_date}}. Gerne unterbreiten wir Ihnen folgendes Angebot.',
    },
    closing: {
      name: 'Beispiel: Schluss',
      body: 'Das Angebot ist gültig bis {{valid_until}}. Wir freuen uns auf Ihre Rückmeldung.\n\nHerzliche Grüsse\n{{business_name}}',
    },
    terms: {
      name: 'Beispiel: Zahlungsbedingungen',
      body: '50 % bei Auftragserteilung, der Rest innert 30 Tagen nach dem Anlass.\n(Beispieltext — bitte an Ihre Bedingungen anpassen.)',
    },
    template: {
      name: 'Beispiel: Hochzeitsreportage',
      description: 'Stundensatz nach den Stunden des Angebots, Bildbearbeitung, Anfahrt, zwei Zusatzoptionen und Texte. Passen Sie Preise und Texte an und veröffentlichen Sie die Vorlage.',
    },
  },
  en: {
    services: {
      hourly: {
        name: 'Example: Photography (hourly rate)', description: 'Photography on location', unit: 'hour', price_mode: 'hour',
        unit_price_minor: 0, category: 'Photography',
        details_text: 'The price comes from the customer\'s hourly rate or from your default rate.',
      },
      editing: {
        name: 'Example: Image editing', description: 'Image editing per image', unit: 'piece', unit_price_minor: 800,
        category: 'Post-production', details_text: 'Selection, colour and exposure correction.',
      },
      travel: {
        name: 'Example: Travel', description: 'Travel per km', unit: 'km', unit_price_minor: 70, category: 'Expenses',
      },
      drone: {
        name: 'Example: Drone footage', description: 'Drone footage', unit: 'flat', unit_price_minor: 25000,
        category: 'Photography',
      },
      album: {
        name: 'Example: Photo book 30×30 cm', description: 'Photo book 30×30 cm, 40 pages', unit: 'piece',
        unit_price_minor: 39000, category: 'Products',
      },
    },
    package: {
      name: 'Example: Wedding basic',
      description: 'Photography by the hour, image editing and travel. The hours come from the quote.',
    },
    club: { name: 'Example: Club discount', description: 'For members of our partner club. No end date.' },
    early: { name: 'Example: Early booking', description: 'For bookings until the end of next year.' },
    intro: {
      name: 'Example: Wedding introduction',
      body: 'Dear {{customer_name}}\n\nthank you for your enquiry about {{event_name}} on {{event_date}}. We are happy to offer the following.',
    },
    closing: {
      name: 'Example: Closing',
      body: 'This quote is valid until {{valid_until}}. We look forward to hearing from you.\n\nKind regards\n{{business_name}}',
    },
    terms: {
      name: 'Example: Payment terms',
      body: '50 % on booking, the rest within 30 days after the event.\n(Example text — adapt it to your own terms.)',
    },
    template: {
      name: 'Example: Wedding coverage',
      description: 'An hourly line that follows the quote\'s hours, image editing, travel, two add-ons and texts. Adjust the prices and texts, then publish the template.',
    },
  },
};

/** The business's document language (business profile), else the install's default language. */
async function installLanguage() {
  try {
    const profile = await db('business_profile').where({ id: 1 }).first();
    const value = (profile && profile.default_locale) || await getAppSetting('general_default_language');
    return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en' : 'de';
  } catch (_) {
    return 'de';
  }
}

async function seed() {
  const language = await installLanguage();
  const x = EXAMPLES[language];
  const quoteService = require('./quoteService');
  const catalog = require('./quoteCatalogService');
  const templates = require('./quoteTemplateService');

  const presets = {};
  for (const [key, def] of Object.entries(x.services)) {
    presets[key] = (await quoteService.createLineItemPreset({ ...def, currency: 'CHF', price_mode: def.price_mode || 'fixed' })).id;
  }
  const pkg = await catalog.savePackage(null, {
    ...x.package,
    currency: 'CHF',
    items: [
      { preset_id: presets.hourly, bound_to: 'hours' },
      { preset_id: presets.editing, quantity: 300 },
      { preset_id: presets.travel, quantity: 60 },
    ],
  });
  const club = await catalog.createPromotion({ ...x.club, type: 'fixed', value_minor: 30000, currency: 'CHF' });
  const early = await catalog.createPromotion({
    ...x.early, type: 'percent', percent: 10, valid_until: `${new Date().getFullYear() + 1}-12-31`,
  });
  const intro = await catalog.createTextBlock({ ...x.intro, kind: 'intro', language });
  const closing = await catalog.createTextBlock({ ...x.closing, kind: 'closing', language });
  const terms = await catalog.createTextBlock({ ...x.terms, kind: 'terms', language });

  // Archived: out of the quote editor's pickers until someone restores them.
  const off = { is_active: formatBoolean(false), updated_at: new Date() };
  await db('quote_line_item_presets').whereIn('id', Object.values(presets)).update(off);
  await db('quote_packages').where({ id: pkg.id }).update(off);
  await db('quote_promotions').whereIn('id', [club.id, early.id]).update(off);
  await db('quote_text_blocks').whereIn('id', [intro.id, closing.id, terms.id]).update(off);

  // The template carries its own lines and texts, so it can be published and
  // used straight away; it doesn't depend on the archived entries above.
  const line = (key, extra) => {
    const def = x.services[key];
    return {
      description: def.description, unit: def.unit, unitPriceMinor: def.unit_price_minor,
      detailsText: def.details_text || null, ...extra,
    };
  };
  await templates.createTemplate({
    ...x.template,
    language,
    currency: 'CHF',
    draft: {
      sections: [
        // A fixed hourly price whose quantity follows the quote's hours.
        { type: 'line', line: line('hourly', { unitPriceMinor: 18000, boundTo: 'hours', detailsText: null }), children: [] },
        { type: 'line', line: line('editing', { quantity: 300 }), children: [] },
        { type: 'line', line: line('travel', { quantity: 60 }), children: [] },
        { type: 'line', line: line('drone', { quantity: 1 }), children: [], isOptional: true },
        { type: 'line', line: line('album', { quantity: 1 }), children: [], isOptional: true },
      ],
      introText: x.intro.body,
      outroText: x.closing.body,
      hours: 8,
      validityDays: 30,
    },
  }, null);
  logger.info(`Seeded the quote catalogue examples (${language})`);
}

let pending = null;

/** Seed the examples once per install. Never throws; a failure is logged. */
async function ensureCatalogExamples() {
  if (pending) return pending;
  pending = (async () => {
    try {
      if (!(await db.schema.hasTable('quote_templates'))) return;
      const seeded = await getAppSetting(SETTING);
      if (seeded === true || seeded === 'true' || seeded === 1) return;
      // Claimed before seeding: a failure half-way leaves some examples,
      // never a second set.
      await upsertAppSetting(SETTING, JSON.stringify(true), 'boolean');
      await seed();
    } catch (err) {
      logger.warn('Could not seed the quote catalogue examples', { message: err.message });
    }
  })();
  return pending;
}

module.exports = {
  SETTING,
  EXAMPLES,
  ensureCatalogExamples,
  _resetForTests: () => { pending = null; },
};
