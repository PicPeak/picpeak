/**
 * Migration 382: the website contact form's mails (issue 2618).
 *
 *   website_contact_admin         a new message, to the studio (the
 *                                 recipients of the contact form settings,
 *                                 else the business or support address)
 *   website_contact_confirmation  "we got your message", to the visitor;
 *                                 off by default, only with a spam check on,
 *                                 never with the message in it
 *
 * Both are editable under Settings › Email like every other template, in the
 * website category behind the websiteBuilder flag. Insert-only: a template or
 * a translation that exists, edited or not, is left as it is. en and de are
 * reviewed; pt is machine-suggested and flagged for native review.
 */
const TEMPLATES = {
  website_contact_admin: {
    variables: ['sender_name', 'sender_email', 'sender_phone', 'event_date', 'page_title', 'page_url', 'message', 'inbox_link'],
    translations: {
      en: {
        subject: 'Website enquiry from {{sender_name}}',
        body_html: `<h2>New message from your website</h2>
<p><strong>{{sender_name}}</strong> &lt;{{sender_email}}&gt; wrote on <a href="{{page_url}}">{{page_title}}</a>:</p>
<div style="white-space: pre-wrap; padding: 12px 16px; border-left: 3px solid #ddd; margin: 16px 0;">{{message}}</div>
{{#if sender_phone}}<p>Phone: {{sender_phone}}</p>{{/if}}
{{#if event_date}}<p>Event date: {{event_date}}</p>{{/if}}
<p>Reply to {{sender_email}}, or read it in your inbox:</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{inbox_link}}" class="button">Open messages</a></p>`,
        body_text: 'New message from your website\n\n{{sender_name}} <{{sender_email}}> wrote on {{page_title}} ({{page_url}}):\n\n{{message}}\n{{#if sender_phone}}\nPhone: {{sender_phone}}{{/if}}{{#if event_date}}\nEvent date: {{event_date}}{{/if}}\n\nReply to {{sender_email}}, or read it in your inbox: {{inbox_link}}',
      },
      de: {
        subject: 'Website-Anfrage von {{sender_name}}',
        body_html: `<h2>Neue Nachricht über Ihre Website</h2>
<p><strong>{{sender_name}}</strong> &lt;{{sender_email}}&gt; hat auf <a href="{{page_url}}">{{page_title}}</a> geschrieben:</p>
<div style="white-space: pre-wrap; padding: 12px 16px; border-left: 3px solid #ddd; margin: 16px 0;">{{message}}</div>
{{#if sender_phone}}<p>Telefon: {{sender_phone}}</p>{{/if}}
{{#if event_date}}<p>Datum des Anlasses: {{event_date}}</p>{{/if}}
<p>Antworten Sie an {{sender_email}} oder lesen Sie die Nachricht in Ihrem Posteingang:</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{inbox_link}}" class="button">Nachrichten öffnen</a></p>`,
        body_text: 'Neue Nachricht über Ihre Website\n\n{{sender_name}} <{{sender_email}}> hat auf {{page_title}} ({{page_url}}) geschrieben:\n\n{{message}}\n{{#if sender_phone}}\nTelefon: {{sender_phone}}{{/if}}{{#if event_date}}\nDatum des Anlasses: {{event_date}}{{/if}}\n\nAntworten Sie an {{sender_email}} oder lesen Sie die Nachricht in Ihrem Posteingang: {{inbox_link}}',
      },
      pt: {
        subject: 'Pedido do site de {{sender_name}}',
        body_html: `<h2>Nova mensagem do seu site</h2>
<p><strong>{{sender_name}}</strong> &lt;{{sender_email}}&gt; escreveu em <a href="{{page_url}}">{{page_title}}</a>:</p>
<div style="white-space: pre-wrap; padding: 12px 16px; border-left: 3px solid #ddd; margin: 16px 0;">{{message}}</div>
{{#if sender_phone}}<p>Telefone: {{sender_phone}}</p>{{/if}}
{{#if event_date}}<p>Data do evento: {{event_date}}</p>{{/if}}
<p>Responda para {{sender_email}} ou leia a mensagem na sua caixa de entrada:</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{inbox_link}}" class="button">Abrir mensagens</a></p>`,
        body_text: 'Nova mensagem do seu site\n\n{{sender_name}} <{{sender_email}}> escreveu em {{page_title}} ({{page_url}}):\n\n{{message}}\n{{#if sender_phone}}\nTelefone: {{sender_phone}}{{/if}}{{#if event_date}}\nData do evento: {{event_date}}{{/if}}\n\nResponda para {{sender_email}} ou leia a mensagem na sua caixa de entrada: {{inbox_link}}',
      },
    },
  },
  website_contact_confirmation: {
    variables: ['sender_name', 'business_name'],
    translations: {
      en: {
        subject: 'We received your message',
        body_html: `<h2>Thank you, {{sender_name}}</h2>
<p>We received your message and will get back to you soon.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
        body_text: 'Thank you, {{sender_name}}.\n\nWe received your message and will get back to you soon.{{#if business_name}}\n\n{{business_name}}{{/if}}',
      },
      de: {
        subject: 'Wir haben Ihre Nachricht erhalten',
        body_html: `<h2>Vielen Dank, {{sender_name}}</h2>
<p>Wir haben Ihre Nachricht erhalten und melden uns bald bei Ihnen.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
        body_text: 'Vielen Dank, {{sender_name}}.\n\nWir haben Ihre Nachricht erhalten und melden uns bald bei Ihnen.{{#if business_name}}\n\n{{business_name}}{{/if}}',
      },
      pt: {
        subject: 'Recebemos a sua mensagem',
        body_html: `<h2>Obrigado, {{sender_name}}</h2>
<p>Recebemos a sua mensagem e entraremos em contacto em breve.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
        body_text: 'Obrigado, {{sender_name}}.\n\nRecebemos a sua mensagem e entraremos em contacto em breve.{{#if business_name}}\n\n{{business_name}}{{/if}}',
      },
    },
  },
};

// Each translation on its own: a run that stopped part-way (SQLite runs a
// migration without a transaction) gets the missing languages on the next.
async function seedTranslations(knex, templateId, translations) {
  if (!(await knex.schema.hasTable('email_template_translations'))) return;
  for (const [language, content] of Object.entries(translations)) {
    // eslint-disable-next-line no-await-in-loop -- one language at a time
    if (await knex('email_template_translations').where({ template_id: templateId, language }).first('id')) continue;
    // eslint-disable-next-line no-await-in-loop
    await knex('email_template_translations').insert({
      template_id: templateId,
      language,
      subject: content.subject,
      body_html: content.body_html,
      body_text: content.body_text,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

async function seedTemplate(knex, key, { variables, translations }) {
  const existing = await knex('email_templates').where({ template_key: key }).first('id');
  if (existing) return seedTranslations(knex, existing.id, translations);
  const cols = await knex('email_templates').columnInfo();
  const en = translations.en;
  const row = { template_key: key, variables: JSON.stringify(variables) };
  if ('category' in cols) row.category = 'website';
  if ('subcategory' in cols) row.subcategory = null;
  if ('feature_flag' in cols) row.feature_flag = 'websiteBuilder';
  if ('created_at' in cols) row.created_at = new Date().toISOString();
  if ('updated_at' in cols) row.updated_at = new Date().toISOString();
  // Pre-075 installs keep content in per-language columns.
  for (const col of Object.keys(cols)) {
    if (col === 'subject' || /^subject_[a-z]{2,3}$/i.test(col)) row[col] = en.subject;
    else if (col === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(col)) row[col] = en.body_html;
    else if (col === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(col)) row[col] = en.body_text;
  }
  const inserted = await knex('email_templates').insert(row).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  if (templateId) await seedTranslations(knex, templateId, translations);
  return undefined;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  for (const [key, template] of Object.entries(TEMPLATES)) {
    await seedTemplate(knex, key, template); // eslint-disable-line no-await-in-loop
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  for (const key of Object.keys(TEMPLATES)) {
    // eslint-disable-next-line no-await-in-loop
    const template = await knex('email_templates').where({ template_key: key }).first('id');
    // SQLite does not enforce 075's cascade: the translations go first.
    if (template && await knex.schema.hasTable('email_template_translations')) {
      await knex('email_template_translations').where({ template_id: template.id }).del(); // eslint-disable-line no-await-in-loop
    }
    await knex('email_templates').where({ template_key: key }).del(); // eslint-disable-line no-await-in-loop
  }
};

exports.TEMPLATES = TEMPLATES;
