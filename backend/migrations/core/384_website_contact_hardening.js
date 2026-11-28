/**
 * Migration 384 (issue 2618, security review of the website builder):
 *
 *  - The visitor's confirmation of a contact message carries only the
 *    studio's fixed text, nothing the visitor typed: the default templates
 *    of website_contact_confirmation (migration 382) lose {{sender_name}}.
 *    Insert-only in spirit: a subject or body the studio has edited (any
 *    text other than 382's default) is left as it is.
 *  - website_contact_confirmations.address_key holds 255 characters (an
 *    e-mail address's limit) instead of 254.
 *
 * down: the texts are not put back (an old default would echo the name
 * again); the column length stays (harmless either way).
 */
const m382 = require('./382_website_contact_emails');

const KEY = 'website_contact_confirmation';
const VARIABLES = ['business_name'];

const CONFIRMATION = {
  en: {
    subject: 'We received your message',
    body_html: `<h2>Thank you for your message</h2>
<p>We received it and will get back to you soon.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Thank you for your message.\n\nWe received it and will get back to you soon.{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  de: {
    subject: 'Wir haben Ihre Nachricht erhalten',
    body_html: `<h2>Vielen Dank für Ihre Nachricht</h2>
<p>Wir haben sie erhalten und melden uns bald bei Ihnen.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Vielen Dank für Ihre Nachricht.\n\nWir haben sie erhalten und melden uns bald bei Ihnen.{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  pt: {
    subject: 'Recebemos a sua mensagem',
    body_html: `<h2>Obrigado pela sua mensagem</h2>
<p>Recebemo-la e entraremos em contacto em breve.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Obrigado pela sua mensagem.\n\nRecebemo-la e entraremos em contacto em breve.{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
};
const FIELDS = ['subject', 'body_html', 'body_text'];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_templates')) {
    const template = await knex('email_templates').where({ template_key: KEY }).first();
    if (template) {
      const old = m382.TEMPLATES[KEY].translations;
      await knex('email_templates').where({ id: template.id }).update({ variables: JSON.stringify(VARIABLES) });
      // Pre-075 installs keep the English text on the template row itself.
      const rowUpdate = {};
      for (const field of FIELDS) {
        if (field in template && template[field] === old.en[field]) rowUpdate[field] = CONFIRMATION.en[field];
      }
      if (Object.keys(rowUpdate).length) await knex('email_templates').where({ id: template.id }).update(rowUpdate);
      if (await knex.schema.hasTable('email_template_translations')) {
        for (const [language, text] of Object.entries(CONFIRMATION)) {
          // eslint-disable-next-line no-await-in-loop
          const row = await knex('email_template_translations').where({ template_id: template.id, language }).first();
          if (!row) continue;
          // Each field only while it is still 382's default.
          const update = {};
          for (const field of FIELDS) {
            if (old[language] && row[field] === old[language][field]) update[field] = text[field];
          }
          if (Object.keys(update).length) {
            // eslint-disable-next-line no-await-in-loop
            await knex('email_template_translations').where({ id: row.id }).update({ ...update, updated_at: new Date().toISOString() });
          }
        }
      }
    }
  }

  if (await knex.schema.hasTable('website_contact_confirmations') && knex.client.config.client !== 'sqlite3') {
    // SQLite does not enforce a varchar length; PostgreSQL does.
    await knex.raw('ALTER TABLE website_contact_confirmations ALTER COLUMN address_key TYPE varchar(255)');
  }
};

exports.down = async function down() {};

exports.CONFIRMATION = CONFIRMATION;
