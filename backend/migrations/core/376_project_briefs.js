'use strict';

/**
 * Migration 376: project briefs (issue 2678).
 *
 * The agreed details of a job (who is picked up where and when, the registry
 * office slot, guest count, ...) as fields the studio fills in, shown to the
 * customer in the portal once the studio sends an update.
 *
 *   project_brief_fields   the templates: one field list for every occasion
 *                          (occasion NULL, "global") and one per event type
 *                          (occasion = event_types.slug_prefix, the value
 *                          projects.event_type stores)
 *     label / label_translations   default label + { <lang>: label }
 *     field_type           short_text | long_text | date | time | datetime |
 *                          place | place_time | number | yes_no |
 *                          project_date | project_location | project_guests
 *                          (the last three show the project's own event_date,
 *                          location and guest_count on a project brief)
 *     visible_default      whether the customer sees the field
 *     position             order inside its list
 *
 *   project_briefs         one brief per project OR per customer (exactly one
 *                          owner). A customer brief picks its occasion itself;
 *                          a project brief takes projects.event_type.
 *     shared_arrangements  free text the customer sees
 *     notified_at / notified_snapshot   the last update sent to the customer:
 *                          when, and the customer-visible state it carried
 *                          (what the portal shows, and the base of the next
 *                          "what changed" list)
 *
 *   project_brief_values   the values, per brief and field. field_id has no
 *                          foreign key on purpose: a value outlives its
 *                          template field and stays readable (label and type
 *                          are kept with it). visible NULL = the template's
 *                          default.
 *
 * Seeds a wedding template and the project_brief_updated mail (en and de
 * reviewed, the other languages flagged for native review). Gated by the
 * existing `projects` flag; no flag of its own.
 *
 * Additive, hasTable-guarded, idempotent.
 */

const TEMPLATE_KEY = 'project_brief_updated';
const TEMPLATE_VARIABLES = ['customer_name', 'business_name', 'brief_title', 'brief_changes_html', 'brief_changes_text', 'portal_link'];

const WEDDING_FIELDS = [
  { type: 'short_text', en: 'Bride\'s name', de: 'Name der Braut', es: 'Nombre de la novia', fr: 'Nom de la mariée', nl: 'Naam van de bruid', pt: 'Nome da noiva', ru: 'Имя невесты', sl: 'Ime neveste' },
  { type: 'short_text', en: 'Groom\'s name', de: 'Name des Bräutigams', es: 'Nombre del novio', fr: 'Nom du marié', nl: 'Naam van de bruidegom', pt: 'Nome do noivo', ru: 'Имя жениха', sl: 'Ime ženina' },
  { type: 'project_date', en: 'Wedding date', de: 'Hochzeitsdatum', es: 'Fecha de la boda', fr: 'Date du mariage', nl: 'Trouwdatum', pt: 'Data do casamento', ru: 'Дата свадьбы', sl: 'Datum poroke' },
  { type: 'place_time', en: 'Bride pickup', de: 'Abholung der Braut', es: 'Recogida de la novia', fr: 'Prise en charge de la mariée', nl: 'Ophalen van de bruid', pt: 'Buscar a noiva', ru: 'Встреча невесты', sl: 'Prevzem neveste' },
  { type: 'place_time', en: 'Registry office', de: 'Standesamt', es: 'Registro civil', fr: 'Mairie', nl: 'Gemeentehuis', pt: 'Cartório', ru: 'ЗАГС', sl: 'Matični urad' },
  { type: 'place_time', en: 'Getting ready', de: 'Getting Ready', es: 'Preparativos', fr: 'Préparatifs', nl: 'Voorbereidingen', pt: 'Preparação', ru: 'Сборы', sl: 'Priprave' },
  { type: 'place_time', en: 'Outdoor shoot', de: 'Outdoor-Shooting', es: 'Sesión al aire libre', fr: 'Séance photo en extérieur', nl: 'Fotoshoot buiten', pt: 'Sessão ao ar livre', ru: 'Фотосессия на улице', sl: 'Fotografiranje na prostem' },
  { type: 'place', en: 'Backup location', de: 'Ausweichort', es: 'Lugar alternativo', fr: 'Lieu de repli', nl: 'Uitwijklocatie', pt: 'Local alternativo', ru: 'Запасная локация', sl: 'Nadomestna lokacija' },
  { type: 'project_guests', en: 'Guest count', de: 'Anzahl Gäste', es: 'Número de invitados', fr: 'Nombre d\'invités', nl: 'Aantal gasten', pt: 'Número de convidados', ru: 'Количество гостей', sl: 'Število gostov' },
  { type: 'date', en: 'Plus-one allowed until', de: 'Begleitperson möglich bis', es: 'Acompañante posible hasta', fr: 'Accompagnant possible jusqu\'au', nl: 'Introducé mogelijk tot', pt: 'Acompanhante possível até', ru: 'Можно с парой до', sl: 'Spremljevalec mogoč do' },
];

// en and de are reviewed; the other languages are machine-suggested and
// flagged for native review.
const TRANSLATIONS = {
  en: {
    subject: 'Your booking details were updated{{#if brief_title}}: {{brief_title}}{{/if}}',
    body_html: `<h2>Your booking details were updated</h2>
<p>Dear {{customer_name}},</p>
<p>We have updated the agreed details{{#if brief_title}} for <strong>{{brief_title}}</strong>{{/if}}. This is what changed:</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">View all details</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Dear {{customer_name}},\n\nWe have updated the agreed details{{#if brief_title}} for {{brief_title}}{{/if}}. This is what changed:\n\n{{brief_changes_text}}{{#if portal_link}}\n\nAll details: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  de: {
    subject: 'Ihre Buchungsdetails wurden aktualisiert{{#if brief_title}}: {{brief_title}}{{/if}}',
    body_html: `<h2>Ihre Buchungsdetails wurden aktualisiert</h2>
<p>Guten Tag {{customer_name}},</p>
<p>wir haben die vereinbarten Details{{#if brief_title}} für <strong>{{brief_title}}</strong>{{/if}} aktualisiert. Das hat sich geändert:</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">Alle Details ansehen</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Guten Tag {{customer_name}},\n\nwir haben die vereinbarten Details{{#if brief_title}} für {{brief_title}}{{/if}} aktualisiert. Das hat sich geändert:\n\n{{brief_changes_text}}{{#if portal_link}}\n\nAlle Details: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  es: {
    subject: 'Se han actualizado los detalles de su reserva{{#if brief_title}}: {{brief_title}}{{/if}}',
    body_html: `<h2>Se han actualizado los detalles de su reserva</h2>
<p>Hola {{customer_name}}:</p>
<p>Hemos actualizado los detalles acordados{{#if brief_title}} para <strong>{{brief_title}}</strong>{{/if}}. Esto es lo que ha cambiado:</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">Ver todos los detalles</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Hola {{customer_name}}:\n\nHemos actualizado los detalles acordados{{#if brief_title}} para {{brief_title}}{{/if}}. Esto es lo que ha cambiado:\n\n{{brief_changes_text}}{{#if portal_link}}\n\nTodos los detalles: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  fr: {
    subject: 'Les détails de votre réservation ont été mis à jour{{#if brief_title}} : {{brief_title}}{{/if}}',
    body_html: `<h2>Les détails de votre réservation ont été mis à jour</h2>
<p>Bonjour {{customer_name}},</p>
<p>Nous avons mis à jour les détails convenus{{#if brief_title}} pour <strong>{{brief_title}}</strong>{{/if}}. Voici ce qui a changé :</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">Voir tous les détails</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Bonjour {{customer_name}},\n\nNous avons mis à jour les détails convenus{{#if brief_title}} pour {{brief_title}}{{/if}}. Voici ce qui a changé :\n\n{{brief_changes_text}}{{#if portal_link}}\n\nTous les détails : {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  nl: {
    subject: 'Uw boekingsgegevens zijn bijgewerkt{{#if brief_title}}: {{brief_title}}{{/if}}',
    body_html: `<h2>Uw boekingsgegevens zijn bijgewerkt</h2>
<p>Beste {{customer_name}},</p>
<p>We hebben de afgesproken gegevens{{#if brief_title}} voor <strong>{{brief_title}}</strong>{{/if}} bijgewerkt. Dit is er veranderd:</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">Alle gegevens bekijken</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Beste {{customer_name}},\n\nWe hebben de afgesproken gegevens{{#if brief_title}} voor {{brief_title}}{{/if}} bijgewerkt. Dit is er veranderd:\n\n{{brief_changes_text}}{{#if portal_link}}\n\nAlle gegevens: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  pt: {
    subject: 'Os detalhes da sua reserva foram atualizados{{#if brief_title}}: {{brief_title}}{{/if}}',
    body_html: `<h2>Os detalhes da sua reserva foram atualizados</h2>
<p>Olá {{customer_name}},</p>
<p>Atualizamos os detalhes combinados{{#if brief_title}} para <strong>{{brief_title}}</strong>{{/if}}. Veja o que mudou:</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">Ver todos os detalhes</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá {{customer_name}},\n\nAtualizamos os detalhes combinados{{#if brief_title}} para {{brief_title}}{{/if}}. Veja o que mudou:\n\n{{brief_changes_text}}{{#if portal_link}}\n\nTodos os detalhes: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  ru: {
    subject: 'Детали вашего заказа обновлены{{#if brief_title}}: {{brief_title}}{{/if}}',
    body_html: `<h2>Детали вашего заказа обновлены</h2>
<p>Здравствуйте, {{customer_name}}!</p>
<p>Мы обновили согласованные детали{{#if brief_title}} для <strong>{{brief_title}}</strong>{{/if}}. Вот что изменилось:</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">Посмотреть все детали</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Здравствуйте, {{customer_name}}!\n\nМы обновили согласованные детали{{#if brief_title}} для {{brief_title}}{{/if}}. Вот что изменилось:\n\n{{brief_changes_text}}{{#if portal_link}}\n\nВсе детали: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  sl: {
    subject: 'Podrobnosti vaše rezervacije so posodobljene{{#if brief_title}}: {{brief_title}}{{/if}}',
    body_html: `<h2>Podrobnosti vaše rezervacije so posodobljene</h2>
<p>Pozdravljeni, {{customer_name}},</p>
<p>posodobili smo dogovorjene podrobnosti{{#if brief_title}} za <strong>{{brief_title}}</strong>{{/if}}. Spremenilo se je naslednje:</p>
{{brief_changes_html}}
{{#if portal_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{portal_link}}" class="button">Ogled vseh podrobnosti</a></p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Pozdravljeni, {{customer_name}},\n\nposodobili smo dogovorjene podrobnosti{{#if brief_title}} za {{brief_title}}{{/if}}. Spremenilo se je naslednje:\n\n{{brief_changes_text}}{{#if portal_link}}\n\nVse podrobnosti: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
};

async function seedWeddingTemplate(knex) {
  if (await knex('project_brief_fields').where({ occasion: 'wedding' }).first('id')) return;
  const now = new Date().toISOString();
  await knex('project_brief_fields').insert(WEDDING_FIELDS.map(({ type, en, ...translations }, position) => ({
    occasion: 'wedding',
    label: en,
    label_translations: JSON.stringify(translations),
    field_type: type,
    visible_default: true,
    position,
    created_at: now,
    updated_at: now,
  })));
}

async function seedEmailTemplate(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first('id')) return;

  const cols = await knex('email_templates').columnInfo();
  const en = TRANSLATIONS.en;
  const row = { template_key: TEMPLATE_KEY, variables: JSON.stringify(TEMPLATE_VARIABLES) };
  if ('category' in cols) row.category = 'customers';
  if ('subcategory' in cols) row.subcategory = null;
  if ('feature_flag' in cols) row.feature_flag = 'projects';
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
  if (templateId && await knex.schema.hasTable('email_template_translations')) {
    for (const [language, content] of Object.entries(TRANSLATIONS)) {
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
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('projects')) || !(await knex.schema.hasTable('customer_accounts'))) return;

  if (!(await knex.schema.hasTable('project_brief_fields'))) {
    await knex.schema.createTable('project_brief_fields', (t) => {
      t.increments('id').primary();
      t.string('occasion', 50).nullable();
      t.string('label', 120).notNullable();
      t.text('label_translations').nullable();
      t.string('field_type', 20).notNullable();
      t.boolean('visible_default').notNullable().defaultTo(true);
      t.integer('position').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['occasion', 'position']);
    });
  }

  if (!(await knex.schema.hasTable('project_briefs'))) {
    await knex.schema.createTable('project_briefs', (t) => {
      t.increments('id').primary();
      t.integer('project_id').unsigned().nullable().unique()
        .references('id').inTable('projects').onDelete('CASCADE');
      t.integer('customer_account_id').unsigned().nullable().unique()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      t.string('occasion', 50).nullable();
      t.text('shared_arrangements').nullable();
      t.timestamp('notified_at').nullable();
      t.text('notified_snapshot').nullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      // Exactly one owner: a project, or a customer without a project.
      t.check('(?? IS NULL) <> (?? IS NULL)', ['project_id', 'customer_account_id'], 'project_briefs_one_owner');
    });
  }

  if (!(await knex.schema.hasTable('project_brief_values'))) {
    await knex.schema.createTable('project_brief_values', (t) => {
      t.increments('id').primary();
      t.integer('brief_id').unsigned().notNullable()
        .references('id').inTable('project_briefs').onDelete('CASCADE');
      t.integer('field_id').notNullable();
      t.string('label', 120).notNullable();
      t.string('field_type', 20).notNullable();
      t.text('value').nullable();
      t.boolean('visible').nullable();
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.unique(['brief_id', 'field_id']);
    });
  }

  await seedWeddingTemplate(knex);
  await seedEmailTemplate(knex);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('project_brief_values');
  await knex.schema.dropTableIfExists('project_briefs');
  await knex.schema.dropTableIfExists('project_brief_fields');
  if (await knex.schema.hasTable('email_templates')) {
    // SQLite does not enforce 075's cascade: the translations go first.
    const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first('id');
    if (template && await knex.schema.hasTable('email_template_translations')) {
      await knex('email_template_translations').where({ template_id: template.id }).del();
    }
    await knex('email_templates').where({ template_key: TEMPLATE_KEY }).del();
  }
};

exports.TRANSLATIONS = TRANSLATIONS;
exports.TEMPLATE_VARIABLES = TEMPLATE_VARIABLES;
