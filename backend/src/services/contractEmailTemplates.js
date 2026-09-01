/**
 * Contract email template definitions, extracted from migration 130
 * so both the migration AND a runtime seeder can read from the same
 * source. The runtime seeder is needed because an admin who ran
 * migration 130 BEFORE we added contract_fully_signed to it won't
 * have that template in their email_templates table — yet the
 * dual-party send in contractService.recordAdminCountersignature
 * depends on it. Per the maintainer's "never ship compensation
 * migrations" rule, we self-heal at runtime instead.
 *
 * `ensureContractEmailTemplatesSeeded()` is idempotent — call it as
 * often as you like, only missing rows get inserted. Module-level
 * boolean caches the "all templates verified" state so the check
 * is free after the first call in a process.
 */

const CONTRACT_EMAIL_TEMPLATES = {
  contract_sent: {
    category: 'contracts', feature_flag: 'contracts',
    variables: ['contract_number', 'customer_name', 'response_url', 'title', 'event_name', 'valid_until'],
    en: {
      subject: 'Contract {{contract_number}} ready for your signature',
      body_html: `<h2>Contract {{contract_number}}</h2>
<p>Dear {{customer_name}},</p>
<p>Please find the contract {{contract_number}}{{#if title}} — "{{title}}"{{/if}}{{#if event_name}} for "{{event_name}}"{{/if}} attached.</p>
<p>You can review and sign the contract directly in your browser via the link below:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{response_url}}" class="button">Review &amp; sign contract</a>
</p>
<p>Or open the full contract:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Please sign by {{valid_until}}.</p>{{/if}}`,
      body_text: 'Contract {{contract_number}}\n\nDear {{customer_name}},\n\nPlease review and sign the contract {{contract_number}}.\n\nOpen: {{response_url}}\n\n{{#if valid_until}}Please sign by {{valid_until}}.{{/if}}',
    },
    de: {
      subject: 'Vertrag {{contract_number}} zur Unterzeichnung bereit',
      body_html: `<h2>Vertrag {{contract_number}}</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>im Anhang finden Sie den Vertrag {{contract_number}}{{#if title}} – „{{title}}"{{/if}}{{#if event_name}} für „{{event_name}}"{{/if}}.</p>
<p>Sie können den Vertrag direkt online prüfen und unterzeichnen:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{response_url}}" class="button">Vertrag prüfen &amp; unterzeichnen</a>
</p>
<p>Oder öffnen Sie den vollständigen Vertrag im Browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Bitte unterzeichnen Sie bis {{valid_until}}.</p>{{/if}}`,
      body_text: 'Vertrag {{contract_number}}\n\nSehr geehrte/r {{customer_name}},\n\nbitte prüfen und unterzeichnen Sie den Vertrag {{contract_number}}.\n\nÖffnen: {{response_url}}\n\n{{#if valid_until}}Bitte unterzeichnen bis {{valid_until}}.{{/if}}',
    },
  },
  contract_fully_signed: {
    category: 'contracts', feature_flag: 'contracts',
    variables: ['contract_number', 'customer_name', 'title'],
    en: {
      subject: 'Contract {{contract_number}} fully signed',
      body_html: `<h2>Contract {{contract_number}} — fully signed</h2>
<p>Dear {{customer_name}},</p>
<p>Both parties have now signed contract {{contract_number}}{{#if title}} — "{{title}}"{{/if}}. Please find the fully signed PDF attached for your records.</p>
<p style="font-size: 13px; color: #666;">This is the authoritative signed copy. Keep it alongside the related quote and invoices.</p>`,
      body_text: 'Contract {{contract_number}} is now fully signed by both parties. The signed PDF is attached for your records.',
    },
    de: {
      subject: 'Vertrag {{contract_number}} vollständig unterzeichnet',
      body_html: `<h2>Vertrag {{contract_number}} – vollständig unterzeichnet</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>der Vertrag {{contract_number}}{{#if title}} – „{{title}}"{{/if}} wurde nun von beiden Parteien unterzeichnet. Im Anhang finden Sie das beidseitig unterzeichnete PDF für Ihre Unterlagen.</p>
<p style="font-size: 13px; color: #666;">Dies ist die massgebliche unterzeichnete Fassung. Bewahren Sie sie zusammen mit dem zugehörigen Angebot und den Rechnungen auf.</p>`,
      body_text: 'Vertrag {{contract_number}} ist nun beidseitig unterzeichnet. Das unterzeichnete PDF finden Sie im Anhang.',
    },
  },
  contract_signed_admin_notification: {
    category: 'contracts', feature_flag: 'contracts',
    variables: ['contract_number', 'customer_email', 'signed_customer_name', 'admin_dashboard_url'],
    en: {
      subject: 'Contract {{contract_number}} signed by {{customer_email}}',
      body_html: `<h2>Contract signed</h2><p>{{signed_customer_name}} ({{customer_email}}) has just signed contract <strong>{{contract_number}}</strong>.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Open in admin</a></p>
<p style="font-size: 13px; color: #666;">The signed PDF and signature evidence (typed name, IP, timestamp, signature image if drawn) are available on the contract detail page. To make this fully binding, counter-sign the contract or upload a wet-signed copy.</p>`,
      body_text: 'Contract {{contract_number}} signed by {{signed_customer_name}} ({{customer_email}}). Open: {{admin_dashboard_url}}',
    },
    de: {
      subject: 'Vertrag {{contract_number}} von {{customer_email}} unterzeichnet',
      body_html: `<h2>Vertrag unterzeichnet</h2><p>{{signed_customer_name}} ({{customer_email}}) hat soeben den Vertrag <strong>{{contract_number}}</strong> unterzeichnet.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Im Admin-Bereich öffnen</a></p>
<p style="font-size: 13px; color: #666;">Das unterzeichnete PDF und die Signatur-Belege (Name, IP, Zeitstempel, Signaturbild falls gezeichnet) sind auf der Vertragsdetailseite einsehbar. Für vollständige Verbindlichkeit unterzeichnen Sie den Vertrag gegen oder laden Sie eine handunterschriebene Kopie hoch.</p>`,
      body_text: 'Vertrag {{contract_number}} von {{signed_customer_name}} ({{customer_email}}) unterzeichnet. Öffnen: {{admin_dashboard_url}}',
    },
  },
};

// Cache the "all-seeded" state so the check is free after the first
// successful run. Reset to false on insertion failure so subsequent
// calls retry.
let _seeded = false;

/**
 * Insert any missing contract email templates into email_templates +
 * email_template_translations. Safe to call concurrently — each
 * row's existence check happens inline before insert.
 *
 * Returns the list of templateKeys that were newly inserted (for
 * logging / diagnostics). Empty array = all templates already exist.
 */
async function ensureContractEmailTemplatesSeeded(db, logger) {
  if (_seeded) return [];
  if (!(await db.schema.hasTable('email_templates'))) return [];

  const cols = await db('email_templates').columnInfo();
  const hasTranslationsTable = await db.schema.hasTable('email_template_translations');
  const newlyInserted = [];

  for (const [templateKey, def] of Object.entries(CONTRACT_EMAIL_TEMPLATES)) {
    const existing = await db('email_templates').where({ template_key: templateKey }).first();
    if (existing) continue;

    const enContent = def.en;
    const masterRow = {
      template_key: templateKey,
      variables: JSON.stringify(def.variables),
    };
    if ('category' in cols)     masterRow.category = def.category;
    if ('subcategory' in cols)  masterRow.subcategory = null;
    if ('feature_flag' in cols) masterRow.feature_flag = def.feature_flag;
    if ('created_at' in cols)   masterRow.created_at = new Date();
    if ('updated_at' in cols)   masterRow.updated_at = new Date();

    // Fill any subject_<lang> / body_html_<lang> / body_text_<lang>
    // shaped columns the install happens to have (legacy variants vs
    // the modern email_template_translations table).
    for (const colName of Object.keys(cols)) {
      if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.subject;
      } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_html;
      } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_text;
      }
    }

    try {
      const inserted = await db('email_templates').insert(masterRow).returning('id');
      const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
      if (hasTranslationsTable && templateId) {
        for (const lang of ['en', 'de']) {
          const content = def[lang];
          if (!content) continue;
          await db('email_template_translations').insert({
            template_id: templateId,
            language: lang,
            subject: content.subject,
            body_html: content.body_html,
            body_text: content.body_text,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
      newlyInserted.push(templateKey);
      if (logger) {
        logger.info(`Self-healed missing contract email template at runtime: ${templateKey}`);
      }
    } catch (err) {
      // Keep _seeded=false so the next call retries. Don't throw —
      // the caller (queueEmail upstream) will surface its own error
      // if the template still can't be looked up.
      if (logger) {
        logger.error(`Failed to seed contract email template ${templateKey}`, {
          message: err.message,
        });
      }
      return newlyInserted;
    }
  }

  _seeded = true;
  return newlyInserted;
}

module.exports = {
  CONTRACT_EMAIL_TEMPLATES,
  ensureContractEmailTemplatesSeeded,
};
