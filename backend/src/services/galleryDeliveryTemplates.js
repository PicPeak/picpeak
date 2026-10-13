/**
 * Two-stage delivery mails (issue 1562) — definitions + boot self-heal.
 *
 *   gallery_completed       to the customer when the photographer marks the
 *                           full gallery as ready ("your complete gallery is
 *                           here"). The first-look mail is the normal
 *                           gallery_created; this is the second one that
 *                           brings the customer back.
 *   delivery_due_reminder   to the studio when a promised completion date is
 *                           close or has passed.
 *   download_ready          to a gallery visitor who asked to be mailed when a
 *                           prepared download is ready (issue 1733). Lives
 *                           here because it is the same kind of mail: a
 *                           gallery link with nothing secret in it.
 *   selection_submitted     to the gallery's admin address when a guest
 *                           finishes their selection or approves the edited
 *                           photos (issue 1733, A1).
 *
 * Seeded at boot through _emailTemplateBoot, same rules as
 * eventReminderTemplates.js: a missing key is inserted with EN + DE, an
 * existing key is never touched. Other locales fall back to EN through
 * processTemplate's fallback chain (flagged for native review in the PR).
 * Plain HTML so wrapEmailHtml's palette styles it.
 */

const { upgradeUneditedTemplates } = require('./emailTemplateUpgrade');

const TEMPLATES = {
  gallery_completed: {
    variables: ['host_name', 'customer_name', 'event_name', 'event_date', 'gallery_link', 'photo_count', 'expiry_date'],
    en: {
      subject: 'Your complete gallery is ready: {{event_name}}',
      body_html: `<h2>Your complete gallery is ready</h2>
<p>Dear {{host_name}},</p>
<p>All photos of "{{event_name}}" are now in your gallery: {{photo_count}} photos, including the first look you already received.</p>
<p><a href="{{gallery_link}}">Open your gallery</a></p>
{{#if expiry_date}}<p>The gallery is available until {{expiry_date}}.</p>{{/if}}`,
      body_text: 'Your complete gallery is ready\n\nDear {{host_name}},\n\nAll photos of "{{event_name}}" are now in your gallery: {{photo_count}} photos, including the first look you already received.\n\nOpen your gallery: {{gallery_link}}{{#if expiry_date}}\n\nThe gallery is available until {{expiry_date}}.{{/if}}',
    },
    de: {
      subject: 'Ihre vollständige Galerie ist da: {{event_name}}',
      body_html: `<h2>Ihre vollständige Galerie ist da</h2>
<p>Guten Tag {{host_name}},</p>
<p>Alle Fotos von „{{event_name}}“ sind jetzt in Ihrer Galerie: {{photo_count}} Fotos, inklusive der ersten Auswahl, die Sie bereits erhalten haben.</p>
<p><a href="{{gallery_link}}">Galerie öffnen</a></p>
{{#if expiry_date}}<p>Die Galerie ist bis zum {{expiry_date}} verfügbar.</p>{{/if}}`,
      body_text: 'Ihre vollständige Galerie ist da\n\nGuten Tag {{host_name}},\n\nAlle Fotos von „{{event_name}}“ sind jetzt in Ihrer Galerie: {{photo_count}} Fotos, inklusive der ersten Auswahl, die Sie bereits erhalten haben.\n\nGalerie öffnen: {{gallery_link}}{{#if expiry_date}}\n\nDie Galerie ist bis zum {{expiry_date}} verfügbar.{{/if}}',
    },
  },
  // "Email me when it is ready" for a prepared download (issue 1733). The link
  // opens the gallery, which then offers the archive; it is not the archive.
  download_ready: {
    variables: ['event_name', 'gallery_link', 'available_hours'],
    en: {
      subject: 'Your download is ready: {{event_name}}',
      body_html: `<h2>Your download is ready</h2>
<p>The photos you asked for from "{{event_name}}" have been prepared.</p>
<p><a href="{{gallery_link}}">Open the gallery to download them</a></p>
<p>The download is kept for about {{available_hours}} more hour(s). After that you can simply request it again in the gallery.</p>`,
      body_text: 'Your download is ready\n\nThe photos you asked for from "{{event_name}}" have been prepared.\n\nOpen the gallery to download them: {{gallery_link}}\n\nThe download is kept for about {{available_hours}} more hour(s). After that you can simply request it again in the gallery.',
    },
    de: {
      subject: 'Ihr Download ist bereit: {{event_name}}',
      body_html: `<h2>Ihr Download ist bereit</h2>
<p>Die angeforderten Fotos aus „{{event_name}}“ wurden vorbereitet.</p>
<p><a href="{{gallery_link}}">Galerie öffnen und herunterladen</a></p>
<p>Der Download wird noch etwa {{available_hours}} Stunde(n) aufbewahrt. Danach können Sie ihn in der Galerie einfach erneut anfordern.</p>`,
      body_text: 'Ihr Download ist bereit\n\nDie angeforderten Fotos aus „{{event_name}}“ wurden vorbereitet.\n\nGalerie öffnen und herunterladen: {{gallery_link}}\n\nDer Download wird noch etwa {{available_hours}} Stunde(n) aufbewahrt. Danach können Sie ihn in der Galerie einfach erneut anfordern.',
    },
  },
  delivery_due_reminder: {
    variables: ['event_name', 'due_date', 'delivered_count', 'expected_count', 'admin_link', 'overdue', 'due_soon'],
    en: {
      subject: '{{#if overdue}}Overdue{{/if}}{{#if due_soon}}Due soon{{/if}}: complete gallery for {{event_name}}',
      body_html: `<h2>{{#if overdue}}Complete gallery overdue{{/if}}{{#if due_soon}}Complete gallery due soon{{/if}}</h2>
<p>The complete gallery for "{{event_name}}" was promised by <strong>{{due_date}}</strong>.</p>
<p>{{delivered_count}} of approx. {{expected_count}} photos are in the gallery so far.</p>
<p>When the gallery is complete, mark it as ready so the customer is told.</p>
<p><a href="{{admin_link}}">Open the event</a></p>`,
      body_text: 'The complete gallery for "{{event_name}}" was promised by {{due_date}}.\n\n{{delivered_count}} of approx. {{expected_count}} photos are in the gallery so far.\n\nWhen the gallery is complete, mark it as ready so the customer is told.\n\n{{admin_link}}',
    },
    de: {
      subject: '{{#if overdue}}Überfällig{{/if}}{{#if due_soon}}Bald fällig{{/if}}: vollständige Galerie für {{event_name}}',
      body_html: `<h2>{{#if overdue}}Vollständige Galerie überfällig{{/if}}{{#if due_soon}}Vollständige Galerie bald fällig{{/if}}</h2>
<p>Die vollständige Galerie für „{{event_name}}“ wurde bis <strong>{{due_date}}</strong> zugesagt.</p>
<p>Bisher sind {{delivered_count}} von ca. {{expected_count}} Fotos in der Galerie.</p>
<p>Sobald die Galerie vollständig ist, markieren Sie sie als fertig, damit der Kunde Bescheid bekommt.</p>
<p><a href="{{admin_link}}">Event öffnen</a></p>`,
      body_text: 'Die vollständige Galerie für „{{event_name}}“ wurde bis {{due_date}} zugesagt.\n\nBisher sind {{delivered_count}} von ca. {{expected_count}} Fotos in der Galerie.\n\nSobald die Galerie vollständig ist, markieren Sie sie als fertig, damit der Kunde Bescheid bekommt.\n\n{{admin_link}}',
    },
  },
  // A guest finished their selection or approved the edited photos (issue
  // 1733, A1). To the gallery's admin address; is_selection / is_approval say
  // which, exactly one of them is set.
  selection_submitted: {
    variables: ['event_name', 'guest_name', 'item_count', 'rejected_count', 'note', 'admin_link', 'is_selection', 'is_approval'],
    en: {
      subject: '{{#if is_selection}}Selection finished{{/if}}{{#if is_approval}}Edited photos approved{{/if}}: {{event_name}}',
      body_html: `<h2>{{#if is_selection}}Selection finished{{/if}}{{#if is_approval}}Edited photos approved{{/if}}</h2>
<p>Gallery: "{{event_name}}"</p>
{{#if guest_name}}<p>Guest: {{guest_name}}</p>{{/if}}
{{#if is_selection}}<p>Selected photos: <strong>{{item_count}}</strong></p>
<p>The picks are locked for this guest until you reopen the selection.</p>{{/if}}
{{#if is_approval}}<p>Approved photos: <strong>{{item_count}}</strong></p>{{/if}}
{{#if rejected_count}}<p>Rejected photos: {{rejected_count}}</p>{{/if}}
{{#if is_approval}}<p>The decisions are locked for this guest until you reopen the approval.</p>{{/if}}
{{#if note}}<p>Note: {{note}}</p>{{/if}}
<p><a href="{{admin_link}}">Open the gallery</a></p>`,
      body_text: '{{#if is_selection}}Selection finished{{/if}}{{#if is_approval}}Edited photos approved{{/if}}\n\nGallery: "{{event_name}}"{{#if guest_name}}\nGuest: {{guest_name}}{{/if}}{{#if is_selection}}\nSelected photos: {{item_count}}\n\nThe picks are locked for this guest until you reopen the selection.{{/if}}{{#if is_approval}}\nApproved photos: {{item_count}}{{/if}}{{#if rejected_count}}\nRejected photos: {{rejected_count}}{{/if}}{{#if is_approval}}\n\nThe decisions are locked for this guest until you reopen the approval.{{/if}}{{#if note}}\n\nNote: {{note}}{{/if}}\n\n{{admin_link}}',
    },
    de: {
      subject: '{{#if is_selection}}Auswahl abgeschlossen{{/if}}{{#if is_approval}}Bearbeitete Fotos freigegeben{{/if}}: {{event_name}}',
      body_html: `<h2>{{#if is_selection}}Auswahl abgeschlossen{{/if}}{{#if is_approval}}Bearbeitete Fotos freigegeben{{/if}}</h2>
<p>Galerie: „{{event_name}}“</p>
{{#if guest_name}}<p>Gast: {{guest_name}}</p>{{/if}}
{{#if is_selection}}<p>Ausgewählte Fotos: <strong>{{item_count}}</strong></p>
<p>Die Auswahl dieses Gastes ist gesperrt, bis Sie sie wieder öffnen.</p>{{/if}}
{{#if is_approval}}<p>Freigegebene Fotos: <strong>{{item_count}}</strong></p>{{/if}}
{{#if rejected_count}}<p>Abgelehnte Fotos: {{rejected_count}}</p>{{/if}}
{{#if is_approval}}<p>Die Entscheidungen dieses Gastes sind gesperrt, bis Sie die Freigabe wieder öffnen.</p>{{/if}}
{{#if note}}<p>Anmerkung: {{note}}</p>{{/if}}
<p><a href="{{admin_link}}">Galerie öffnen</a></p>`,
      body_text: '{{#if is_selection}}Auswahl abgeschlossen{{/if}}{{#if is_approval}}Bearbeitete Fotos freigegeben{{/if}}\n\nGalerie: „{{event_name}}“{{#if guest_name}}\nGast: {{guest_name}}{{/if}}{{#if is_selection}}\nAusgewählte Fotos: {{item_count}}\n\nDie Auswahl dieses Gastes ist gesperrt, bis Sie sie wieder öffnen.{{/if}}{{#if is_approval}}\nFreigegebene Fotos: {{item_count}}{{/if}}{{#if rejected_count}}\nAbgelehnte Fotos: {{rejected_count}}{{/if}}{{#if is_approval}}\n\nDie Entscheidungen dieses Gastes sind gesperrt, bis Sie die Freigabe wieder öffnen.{{/if}}{{#if note}}\n\nAnmerkung: {{note}}{{/if}}\n\n{{admin_link}}',
    },
  },
};

// Defaults whose text changed. A stored template still identical to its
// previous default is brought up to date; one an admin has edited is left as
// it is. gallery_completed printed the expiry line unconditionally, so a
// gallery without an expiry date read "available until null".
const PREVIOUS_DEFAULTS = {
  gallery_completed: {
    en: {
      subject: 'Your complete gallery is ready: {{event_name}}',
      body_html: `<h2>Your complete gallery is ready</h2>
<p>Dear {{host_name}},</p>
<p>All photos of "{{event_name}}" are now in your gallery: {{photo_count}} photos, including the first look you already received.</p>
<p><a href="{{gallery_link}}">Open your gallery</a></p>
<p>The gallery is available until {{expiry_date}}.</p>`,
      body_text: 'Your complete gallery is ready\n\nDear {{host_name}},\n\nAll photos of "{{event_name}}" are now in your gallery: {{photo_count}} photos, including the first look you already received.\n\nOpen your gallery: {{gallery_link}}\n\nThe gallery is available until {{expiry_date}}.',
    },
    de: {
      subject: 'Ihre vollständige Galerie ist da: {{event_name}}',
      body_html: `<h2>Ihre vollständige Galerie ist da</h2>
<p>Guten Tag {{host_name}},</p>
<p>Alle Fotos von „{{event_name}}“ sind jetzt in Ihrer Galerie: {{photo_count}} Fotos, inklusive der ersten Auswahl, die Sie bereits erhalten haben.</p>
<p><a href="{{gallery_link}}">Galerie öffnen</a></p>
<p>Die Galerie ist bis zum {{expiry_date}} verfügbar.</p>`,
      body_text: 'Ihre vollständige Galerie ist da\n\nGuten Tag {{host_name}},\n\nAlle Fotos von „{{event_name}}“ sind jetzt in Ihrer Galerie: {{photo_count}} Fotos, inklusive der ersten Auswahl, die Sie bereits erhalten haben.\n\nGalerie öffnen: {{gallery_link}}\n\nDie Galerie ist bis zum {{expiry_date}} verfügbar.',
    },
  },
};

let _seeded = false;

async function ensureGalleryDeliveryTemplatesSeeded(db, logger) {
  if (_seeded) return [];
  if (!(await db.schema.hasTable('email_templates'))) return [];
  const cols = await db('email_templates').columnInfo();
  const hasTranslations = await db.schema.hasTable('email_template_translations');
  const touched = [];

  for (const [templateKey, def] of Object.entries(TEMPLATES)) {
    try {
      if (await db('email_templates').where({ template_key: templateKey }).first('id')) continue;
      const row = { template_key: templateKey, variables: JSON.stringify(def.variables) };
      if ('category' in cols) row.category = 'core';
      if ('subcategory' in cols) row.subcategory = 'gallery';
      if ('created_at' in cols) row.created_at = new Date();
      if ('updated_at' in cols) row.updated_at = new Date();
      for (const col of Object.keys(cols)) {
        if (col === 'subject' || /^subject_en$/i.test(col)) row[col] = def.en.subject;
        else if (col === 'body_html' || /^body_html_en$/i.test(col)) row[col] = def.en.body_html;
        else if (col === 'body_text' || /^body_text_en$/i.test(col)) row[col] = def.en.body_text;
        else if (/^subject_de$/i.test(col)) row[col] = def.de.subject;
        else if (/^body_html_de$/i.test(col)) row[col] = def.de.body_html;
        else if (/^body_text_de$/i.test(col)) row[col] = def.de.body_text;
      }
      // One transaction: a master row without its translations would never be
      // healed, because an existing key is never touched again.
      await db.transaction(async (trx) => {
        const inserted = await trx('email_templates').insert(row).returning('id');
        const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
        if (hasTranslations) {
          for (const language of ['en', 'de']) {
            await trx('email_template_translations').insert({
              template_id: templateId,
              language,
              subject: def[language].subject,
              body_html: def[language].body_html,
              body_text: def[language].body_text,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
        }
      });
      touched.push(templateKey);
      if (logger) logger.info(`Seeded gallery delivery template: ${templateKey}`);
    } catch (err) {
      if (logger) logger.error(`Failed to seed gallery delivery template ${templateKey}`, { message: err.message });
      return touched;
    }
  }
  try {
    await upgradeUneditedTemplates(db, {
      templates: TEMPLATES, previousDefaults: PREVIOUS_DEFAULTS, cols, hasTranslationsTable: hasTranslations, logger,
    });
  } catch (err) {
    if (logger) logger.error('Failed to update unedited gallery delivery templates', { message: err.message });
    return touched;
  }
  _seeded = true;
  return touched;
}

module.exports = { GALLERY_DELIVERY_TEMPLATES: TEMPLATES, PREVIOUS_DEFAULTS, ensureGalleryDeliveryTemplatesSeeded };
