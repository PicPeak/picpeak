/**
 * Pre-event customer reminder templates — definitions + runtime self-heal.
 *
 * Migration 143 originally seeded an empty `event_reminder_default` row.
 * That left admins staring at a blank editor and had no per-event-type
 * variants. Per the maintainer's "never ship compensation migrations" rule
 * (see contractEmailTemplates.js for the same pattern), we self-heal at
 * runtime instead of bolting on a follow-up migration.
 *
 * `ensureEventReminderTemplatesSeeded(db, logger)` is idempotent — call
 * it as often as you like:
 *   - Missing template_keys get inserted with EN+DE example content.
 *   - Existing template_keys whose EN translation is entirely empty
 *     (the legacy migration-143 case) are backfilled with the example
 *     content. Translations that already have any subject/body content
 *     are LEFT ALONE so an admin's customisations never get clobbered.
 *
 * Process-level boolean caches the "all templates verified" state once
 * we've made one successful pass, so the cron's hourly retick is free.
 *
 * Variables expected on every template: customer_name, event_name,
 * event_date, event_type, days_before, business_name. Keep this list in
 * sync with eventReminderService.composePayload.
 *
 * Per-type template keys (`event_reminder_<slug_prefix>`) are seeded for
 * the four SYSTEM event_types from migration 061: wedding, birthday,
 * corporate, other. Admins who add custom event_types via the Event
 * Types settings page get no seeded body — they author their own via
 * the Reminder Emails tab (the "Default" pill on the sidebar makes
 * obvious which types are still riding the catch-all).
 */

const VARIABLES = [
  'customer_name', 'event_name', 'event_date',
  'event_type', 'days_before', 'business_name',
];

// Tiny HTML signature line shared across templates so the maintainer
// only has to brand once. Variables substitute at render time.
const SIGNATURE_EN = `<p style="margin-top: 24px;">See you soon,<br>{{business_name}}</p>`;
const SIGNATURE_DE = `<p style="margin-top: 24px;">Bis bald,<br>{{business_name}}</p>`;

const EVENT_REMINDER_TEMPLATES = {
  event_reminder_default: {
    en: {
      subject: 'Reminder: {{event_name}} in {{days_before}} day(s)',
      body_html: `<p>Hi {{customer_name}},</p>
<p>Just a quick reminder that <strong>{{event_name}}</strong> is coming up on <strong>{{event_date}}</strong> — about {{days_before}} day(s) from now.</p>
<p>A few things that help us hit the ground running on the day:</p>
<ul>
  <li>Confirm the exact start time and address (a what3words pin works great).</li>
  <li>Let us know if there is anything we should keep an eye on — VIPs, surprise moments, restricted areas.</li>
  <li>Indoor venues: a small corner for equipment setup is a huge help.</li>
</ul>
<p>If anything has changed since we last spoke, just hit reply.</p>
${SIGNATURE_EN}`,
      body_text: `Hi {{customer_name}},\n\nJust a quick reminder that {{event_name}} is coming up on {{event_date}} — about {{days_before}} day(s) from now.\n\nA few things that help us hit the ground running on the day:\n- Confirm the exact start time and address.\n- Let us know if there is anything we should keep an eye on (VIPs, surprise moments, restricted areas).\n- Indoor venues: a small corner for equipment setup is a huge help.\n\nIf anything has changed since we last spoke, just hit reply.\n\nSee you soon,\n{{business_name}}`,
    },
    de: {
      subject: 'Erinnerung: {{event_name}} in {{days_before}} Tag(en)',
      body_html: `<p>Hallo {{customer_name}},</p>
<p>kurze Erinnerung: <strong>{{event_name}}</strong> findet am <strong>{{event_date}}</strong> statt — in etwa {{days_before}} Tag(en).</p>
<p>Damit wir am Tag selbst sofort loslegen können, helfen uns folgende Punkte sehr:</p>
<ul>
  <li>Genaue Startzeit und Adresse bestätigen (gerne auch ein what3words-Pin).</li>
  <li>Kurz Bescheid geben, falls etwas besonders zu beachten ist — VIPs, Überraschungsmomente, abgesperrte Bereiche.</li>
  <li>Bei Innen-Locations: eine kleine Ecke für den Equipment-Aufbau ist Gold wert.</li>
</ul>
<p>Hat sich seit unserem letzten Austausch etwas geändert? Einfach kurz auf diese Mail antworten.</p>
${SIGNATURE_DE}`,
      body_text: `Hallo {{customer_name}},\n\nkurze Erinnerung: {{event_name}} findet am {{event_date}} statt — in etwa {{days_before}} Tag(en).\n\nDamit wir am Tag selbst sofort loslegen können, helfen uns folgende Punkte sehr:\n- Genaue Startzeit und Adresse bestätigen.\n- Kurz Bescheid geben, falls etwas besonders zu beachten ist (VIPs, Überraschungsmomente, abgesperrte Bereiche).\n- Bei Innen-Locations: eine kleine Ecke für den Equipment-Aufbau ist Gold wert.\n\nHat sich seit unserem letzten Austausch etwas geändert? Einfach kurz auf diese Mail antworten.\n\nBis bald,\n{{business_name}}`,
    },
  },

  event_reminder_wedding: {
    en: {
      subject: 'Your wedding on {{event_date}} — last details',
      body_html: `<p>Dear {{customer_name}},</p>
<p>Your wedding day is almost here — <strong>{{event_date}}</strong>, in about {{days_before}} day(s). We are very much looking forward to it.</p>
<p>A short pre-day checklist so the photo coverage flows smoothly:</p>
<ul>
  <li><strong>Timeline:</strong> a rough hour-by-hour run-of-day (getting ready → ceremony → portraits → reception → party) helps us anticipate every moment.</li>
  <li><strong>Family shots:</strong> a short list of must-have group photos (with names) keeps the formals quick and stress-free.</li>
  <li><strong>Getting-ready space:</strong> a room with natural light (window-side) makes a real difference.</li>
  <li><strong>Surprises:</strong> let us know about any surprises so we are in the right place at the right moment — and won't accidentally spoil them.</li>
  <li><strong>Logistics:</strong> ceremony start time, venue address, parking notes, and contact number for the day-of coordinator.</li>
</ul>
<p>If anything has shifted since we last spoke — even small things — just hit reply.</p>
${SIGNATURE_EN}`,
      body_text: `Dear {{customer_name}},\n\nYour wedding day is almost here — {{event_date}}, in about {{days_before}} day(s). We are very much looking forward to it.\n\nA short pre-day checklist so the photo coverage flows smoothly:\n- Timeline: a rough hour-by-hour run-of-day helps us anticipate every moment.\n- Family shots: a short list of must-have group photos (with names) keeps the formals quick.\n- Getting-ready space: a room with natural light makes a real difference.\n- Surprises: let us know so we are in the right place — and won't spoil them.\n- Logistics: ceremony start time, venue address, parking notes, coordinator contact.\n\nIf anything has shifted since we last spoke, just hit reply.\n\nSee you soon,\n{{business_name}}`,
    },
    de: {
      subject: 'Eure Hochzeit am {{event_date}} — letzte Details',
      body_html: `<p>Liebe/r {{customer_name}},</p>
<p>euer grosser Tag steht fast vor der Tür — <strong>{{event_date}}</strong>, in etwa {{days_before}} Tag(en). Wir freuen uns sehr darauf.</p>
<p>Eine kurze Checkliste vor dem Tag, damit die fotografische Begleitung reibungslos läuft:</p>
<ul>
  <li><strong>Ablauf:</strong> ein grober Stunden-Ablauf (Getting-Ready → Trauung → Portraits → Empfang → Party) hilft uns enorm, jeden Moment einzuplanen.</li>
  <li><strong>Familienbilder:</strong> eine kurze Liste der Wunsch-Gruppenbilder (mit Namen) hält die Formalitäten knapp und entspannt.</li>
  <li><strong>Getting-Ready-Raum:</strong> ein Zimmer mit Tageslicht (Fensterseite) macht einen riesigen Unterschied.</li>
  <li><strong>Überraschungen:</strong> kurz Bescheid geben, damit wir zur richtigen Zeit am richtigen Ort sind — und nichts versehentlich verraten.</li>
  <li><strong>Logistik:</strong> Beginn der Trauung, Adresse, Parkhinweise, Telefonnummer der Tages-Koordination.</li>
</ul>
<p>Hat sich seit unserem letzten Gespräch etwas verschoben — auch Kleinigkeiten? Einfach kurz antworten.</p>
${SIGNATURE_DE}`,
      body_text: `Liebe/r {{customer_name}},\n\neuer grosser Tag steht fast vor der Tür — {{event_date}}, in etwa {{days_before}} Tag(en). Wir freuen uns sehr darauf.\n\nEine kurze Checkliste vor dem Tag:\n- Ablauf: ein grober Stunden-Ablauf hilft uns enorm.\n- Familienbilder: kurze Liste der Wunsch-Gruppenbilder (mit Namen).\n- Getting-Ready-Raum: ein Zimmer mit Tageslicht macht einen riesigen Unterschied.\n- Überraschungen: kurz Bescheid geben, damit wir zur richtigen Zeit am richtigen Ort sind.\n- Logistik: Beginn der Trauung, Adresse, Parkhinweise, Telefonnummer der Tages-Koordination.\n\nHat sich etwas verschoben? Einfach kurz antworten.\n\nBis bald,\n{{business_name}}`,
    },
  },

  event_reminder_birthday: {
    en: {
      subject: '{{event_name}} on {{event_date}} — quick check-in',
      body_html: `<p>Hi {{customer_name}},</p>
<p>{{event_name}} is coming up on <strong>{{event_date}}</strong> — about {{days_before}} day(s) away. Quick check-in before the day:</p>
<ul>
  <li><strong>Headcount:</strong> roughly how many guests should we expect? Helps us plan group shots and candid coverage.</li>
  <li><strong>Schedule:</strong> when is the cake/song moment? We always want to be ready for that one.</li>
  <li><strong>Theme or dress code:</strong> if there is one, let us know so we can match the vibe.</li>
  <li><strong>Surprises:</strong> any surprise guests or moments we should keep quiet about?</li>
</ul>
<p>Looking forward to celebrating — let us know if anything has changed.</p>
${SIGNATURE_EN}`,
      body_text: `Hi {{customer_name}},\n\n{{event_name}} is coming up on {{event_date}} — about {{days_before}} day(s) away. Quick check-in:\n- Headcount: roughly how many guests?\n- Schedule: when is the cake/song moment?\n- Theme or dress code, if any.\n- Surprises we should keep quiet about?\n\nLooking forward to celebrating — let us know if anything has changed.\n\nSee you soon,\n{{business_name}}`,
    },
    de: {
      subject: '{{event_name}} am {{event_date}} — kurze Rückfrage',
      body_html: `<p>Hallo {{customer_name}},</p>
<p>{{event_name}} steht am <strong>{{event_date}}</strong> an — in etwa {{days_before}} Tag(en). Kurze Rückfrage vor dem Tag:</p>
<ul>
  <li><strong>Personenzahl:</strong> wie viele Gäste werden in etwa kommen? Hilft uns bei Gruppenbildern und der Candid-Strecke.</li>
  <li><strong>Ablauf:</strong> wann ist der Torten-/Ständchen-Moment? Den möchten wir auf keinen Fall verpassen.</li>
  <li><strong>Motto oder Dresscode:</strong> falls vorhanden, gerne kurz Bescheid geben, damit wir die Stimmung treffen.</li>
  <li><strong>Überraschungen:</strong> Gäste oder Momente, über die wir nicht reden sollten?</li>
</ul>
<p>Wir freuen uns auf das Fest — kurz Bescheid geben, falls sich etwas geändert hat.</p>
${SIGNATURE_DE}`,
      body_text: `Hallo {{customer_name}},\n\n{{event_name}} steht am {{event_date}} an — in etwa {{days_before}} Tag(en). Kurze Rückfrage:\n- Personenzahl: wie viele Gäste werden in etwa kommen?\n- Ablauf: wann ist der Torten-/Ständchen-Moment?\n- Motto oder Dresscode, falls vorhanden.\n- Überraschungen, über die wir nicht reden sollten?\n\nKurz Bescheid geben, falls sich etwas geändert hat.\n\nBis bald,\n{{business_name}}`,
    },
  },

  event_reminder_corporate: {
    en: {
      subject: 'Coverage prep: {{event_name}} on {{event_date}}',
      body_html: `<p>Dear {{customer_name}},</p>
<p>{{event_name}} is on <strong>{{event_date}}</strong> — about {{days_before}} day(s) away. To make sure the coverage matches your goals, a few items to confirm:</p>
<ul>
  <li><strong>Shot brief:</strong> what is the photography for — internal comms, press kit, social, website? It affects framing and crops.</li>
  <li><strong>Agenda / run-of-show:</strong> who is speaking when, plus any moments worth flagging (awards, panels, Q&amp;A).</li>
  <li><strong>VIPs &amp; brand:</strong> a short list of names to prioritise, plus the logo/colour direction so we keep the deck consistent.</li>
  <li><strong>Access:</strong> entrance, loading dock if any, on-site contact for the morning. Photo IDs or accreditation needed?</li>
  <li><strong>Confidentiality:</strong> any sessions that are strictly internal / no-photo?</li>
  <li><strong>Delivery:</strong> rough turnaround you need (24h press selects, full gallery later)?</li>
</ul>
<p>Happy to jump on a 10-min call beforehand if it is easier than email.</p>
${SIGNATURE_EN}`,
      body_text: `Dear {{customer_name}},\n\n{{event_name}} is on {{event_date}} — about {{days_before}} day(s) away. To make sure the coverage matches your goals, a few items to confirm:\n- Shot brief: internal comms, press kit, social, website?\n- Agenda / run-of-show: speakers, awards, panels, Q&A.\n- VIPs & brand: names to prioritise, plus logo/colour direction.\n- Access: entrance, loading dock, on-site contact. Photo ID needed?\n- Confidentiality: any no-photo sessions?\n- Delivery: rough turnaround (24h press selects, full gallery later)?\n\nHappy to jump on a 10-min call beforehand if it is easier than email.\n\nSee you soon,\n{{business_name}}`,
    },
    de: {
      subject: 'Vorbereitung Bildbegleitung: {{event_name}} am {{event_date}}',
      body_html: `<p>Sehr geehrte/r {{customer_name}},</p>
<p>{{event_name}} findet am <strong>{{event_date}}</strong> statt — in etwa {{days_before}} Tag(en). Damit die Bildstrecke euren Zielen entspricht, kurz folgende Punkte abstimmen:</p>
<ul>
  <li><strong>Briefing:</strong> wofür sind die Bilder — interne Kommunikation, Pressekit, Social, Website? Hat Einfluss auf Bildausschnitt und Format.</li>
  <li><strong>Agenda / Ablauf:</strong> wer spricht wann, sowie besondere Momente (Awards, Panels, Q&amp;A).</li>
  <li><strong>VIPs &amp; Brand:</strong> kurze Liste der zu priorisierenden Personen, plus Logo-/Farbvorgaben für eine konsistente Bildsprache.</li>
  <li><strong>Zugang:</strong> Eingang, ggf. Anlieferung, Ansprechperson am Morgen. Lichtbildausweis oder Akkreditierung nötig?</li>
  <li><strong>Vertraulichkeit:</strong> Sessions, die ausschliesslich intern sind / kein Foto?</li>
  <li><strong>Lieferung:</strong> grobe Vorgabe zur Turnaround-Zeit (24h Press-Selects, vollständige Galerie später)?</li>
</ul>
<p>Falls eine kurze 10-Min-Abstimmung einfacher ist als E-Mail, gerne jederzeit melden.</p>
${SIGNATURE_DE}`,
      body_text: `Sehr geehrte/r {{customer_name}},\n\n{{event_name}} findet am {{event_date}} statt — in etwa {{days_before}} Tag(en). Damit die Bildstrecke euren Zielen entspricht, kurz folgende Punkte abstimmen:\n- Briefing: interne Kommunikation, Pressekit, Social, Website?\n- Agenda / Ablauf: Speaker, Awards, Panels, Q&A.\n- VIPs & Brand: zu priorisierende Personen, Logo-/Farbvorgaben.\n- Zugang: Eingang, Anlieferung, Ansprechperson am Morgen. Lichtbildausweis nötig?\n- Vertraulichkeit: rein interne Sessions / kein Foto?\n- Lieferung: Turnaround-Zeit (24h Press-Selects, vollständige Galerie später)?\n\nFalls eine 10-Min-Abstimmung einfacher ist, gerne melden.\n\nBis bald,\n{{business_name}}`,
    },
  },

  event_reminder_other: {
    en: {
      subject: '{{event_name}} on {{event_date}} — prep notes',
      body_html: `<p>Hi {{customer_name}},</p>
<p>{{event_name}} is on <strong>{{event_date}}</strong> — about {{days_before}} day(s) away. A short prep note:</p>
<ul>
  <li><strong>Start time &amp; address:</strong> please confirm both — even small changes matter for arrival/setup.</li>
  <li><strong>Run-of-day:</strong> a rough timeline of the key moments (start, highlights, end) helps us be in the right place.</li>
  <li><strong>Setup space:</strong> if indoors, a small corner for gear makes a real difference.</li>
  <li><strong>Anything specific:</strong> people to prioritise, things to avoid, dress code, surprises — just let us know.</li>
</ul>
<p>If anything has changed since we last spoke, hit reply.</p>
${SIGNATURE_EN}`,
      body_text: `Hi {{customer_name}},\n\n{{event_name}} is on {{event_date}} — about {{days_before}} day(s) away. A short prep note:\n- Start time & address: please confirm both.\n- Run-of-day: a rough timeline of the key moments.\n- Setup space: a small corner for gear if indoors.\n- Anything specific: people to prioritise, things to avoid, dress code, surprises.\n\nIf anything has changed, just hit reply.\n\nSee you soon,\n{{business_name}}`,
    },
    de: {
      subject: '{{event_name}} am {{event_date}} — Vorbereitungs-Hinweise',
      body_html: `<p>Hallo {{customer_name}},</p>
<p>{{event_name}} findet am <strong>{{event_date}}</strong> statt — in etwa {{days_before}} Tag(en). Kurz zur Vorbereitung:</p>
<ul>
  <li><strong>Startzeit &amp; Adresse:</strong> bitte beides kurz bestätigen — auch kleine Änderungen sind für Anreise/Aufbau wichtig.</li>
  <li><strong>Ablauf:</strong> ein grober Zeitplan der Schlüsselmomente (Start, Highlights, Ende) hilft uns bei der Positionierung.</li>
  <li><strong>Aufbauplatz:</strong> bei Innen-Locations ist eine kleine Ecke fürs Equipment Gold wert.</li>
  <li><strong>Besonderheiten:</strong> Personen, die im Fokus stehen sollen, Dinge, die vermieden werden sollen, Dresscode, Überraschungen — gerne kurz Bescheid geben.</li>
</ul>
<p>Hat sich seit dem letzten Austausch etwas geändert? Einfach kurz antworten.</p>
${SIGNATURE_DE}`,
      body_text: `Hallo {{customer_name}},\n\n{{event_name}} findet am {{event_date}} statt — in etwa {{days_before}} Tag(en). Kurz zur Vorbereitung:\n- Startzeit & Adresse: bitte beides kurz bestätigen.\n- Ablauf: ein grober Zeitplan der Schlüsselmomente.\n- Aufbauplatz: bei Innen-Locations eine kleine Ecke fürs Equipment.\n- Besonderheiten: Personen im Fokus, Dinge zu vermeiden, Dresscode, Überraschungen.\n\nKurz antworten, falls sich etwas geändert hat.\n\nBis bald,\n{{business_name}}`,
    },
  },
};

let _seeded = false;

/**
 * Idempotent seed/backfill for every entry in EVENT_REMINDER_TEMPLATES.
 * Safe to call repeatedly — both at boot and inside the cron tick.
 *
 * Rules:
 *   - Missing template_key → insert master row + translations.
 *   - Existing template_key whose EN translation is entirely empty
 *     (subject + body_html + body_text all blank) → backfill EN+DE.
 *     This matches the legacy migration-143 "empty seed" case without
 *     ever touching admin-customised content.
 *   - Existing template_key with non-empty EN translation → leave alone.
 *
 * Returns array of template_keys touched (inserted or backfilled) for
 * diagnostic logging.
 */
async function ensureEventReminderTemplatesSeeded(db, logger) {
  if (_seeded) return [];
  if (!(await db.schema.hasTable('email_templates'))) return [];

  const cols = await db('email_templates').columnInfo();
  const hasTranslationsTable = await db.schema.hasTable('email_template_translations');
  const touched = [];

  const isEmpty = (tr) => {
    if (!tr) return true;
    const s = (tr.subject || '').trim();
    const h = (tr.body_html || '').trim();
    const t = (tr.body_text || '').trim();
    return !s && !h && !t;
  };

  const upsertTranslation = async (templateId, language, content) => {
    if (!hasTranslationsTable) return;
    const existing = await db('email_template_translations')
      .where({ template_id: templateId, language })
      .first();
    if (existing && !isEmpty(existing)) return; // never overwrite admin edits
    if (existing) {
      await db('email_template_translations')
        .where({ id: existing.id })
        .update({
          subject: content.subject,
          body_html: content.body_html,
          body_text: content.body_text,
          updated_at: new Date(),
        });
    } else {
      await db('email_template_translations').insert({
        template_id: templateId,
        language,
        subject: content.subject,
        body_html: content.body_html,
        body_text: content.body_text,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  };

  for (const [templateKey, def] of Object.entries(EVENT_REMINDER_TEMPLATES)) {
    try {
      let existing = await db('email_templates').where({ template_key: templateKey }).first();

      if (!existing) {
        const en = def.en;
        const masterRow = {
          template_key: templateKey,
          variables: JSON.stringify(VARIABLES),
        };
        if ('category' in cols)     masterRow.category = 'crm';
        if ('subcategory' in cols)  masterRow.subcategory = 'event_reminder';
        if ('feature_flag' in cols) masterRow.feature_flag = 'crm_event_reminders_enabled';
        if ('created_at' in cols)   masterRow.created_at = new Date();
        if ('updated_at' in cols)   masterRow.updated_at = new Date();
        // Fill legacy subject_<lang>/body_html_<lang> columns if present.
        for (const colName of Object.keys(cols)) {
          if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
            masterRow[colName] = en.subject;
          } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
            masterRow[colName] = en.body_html;
          } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
            masterRow[colName] = en.body_text;
          }
        }
        const inserted = await db('email_templates').insert(masterRow).returning('id');
        const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
        await upsertTranslation(templateId, 'en', def.en);
        await upsertTranslation(templateId, 'de', def.de);
        touched.push(templateKey);
        if (logger) logger.info(`Self-healed event reminder template: ${templateKey}`);
        continue;
      }

      // Template exists — backfill empty translations only.
      if (hasTranslationsTable) {
        const en = await db('email_template_translations')
          .where({ template_id: existing.id, language: 'en' })
          .first();
        if (isEmpty(en)) {
          await upsertTranslation(existing.id, 'en', def.en);
          await upsertTranslation(existing.id, 'de', def.de);
          touched.push(templateKey);
          if (logger) logger.info(`Self-healed empty event reminder translations: ${templateKey}`);
        }
      }
    } catch (err) {
      if (logger) {
        logger.error(`Failed to seed event reminder template ${templateKey}`, {
          message: err.message,
        });
      }
      // Keep _seeded=false so the next pass retries.
      return touched;
    }
  }

  _seeded = true;
  return touched;
}

module.exports = {
  EVENT_REMINDER_TEMPLATES,
  ensureEventReminderTemplatesSeeded,
};
