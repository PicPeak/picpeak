/**
 * Migration: Add `customer_gallery_assigned` email template.
 *
 * Sent when an admin adds new gallery assignments to an existing
 * customer via the "Manage galleries" dialog on the customer detail
 * page. Digest-style — one email per save listing every newly added
 * gallery, not one email per gallery (admins often set up new clients
 * by adding several galleries in a single sitting).
 *
 * Variables:
 *   - customer_name       greeting name (display name / first name / email local)
 *   - gallery_count       integer (string) — number of newly added galleries
 *   - singular            "true" when count === 1 (drives intro wording)
 *   - multiple            "true" when count >  1
 *   - gallery_list_html   pre-rendered <ul> with names + dates; passes
 *                         through unescaped because the service builds it
 *                         from trusted DB fields (event_name from
 *                         admin-owned rows + server-rendered dates).
 *   - gallery_list_text   newline-separated plain-text equivalent for
 *                         the text/plain body.
 *   - dashboard_link      URL of /customer/dashboard on the configured
 *                         frontend origin.
 *
 * Category + flag: 'customers' + customerPortal — categorisation
 * scaffold from migration 098. When the customer portal flag is off,
 * the Templates admin UI chips this card "Feature off" but it's still
 * editable.
 *
 * Translations: en + de hand-translated; nl/pt/ru/fr machine-generated
 * and flagged for native review per project convention.
 *
 * Idempotent: skips if the template_key already exists.
 */

const TRANSLATIONS = {
  en: {
    subject: 'New gallery access on your account',
    body_html: `<h2>You have new gallery access</h2>
<p>Hi {{customer_name}},</p>
{{#if singular}}<p>Your photographer just gave you access to a new gallery on your account:</p>{{/if}}{{#if multiple}}<p>Your photographer just gave you access to {{gallery_count}} new galleries on your account:</p>{{/if}}
{{gallery_list_html}}
<p style="text-align: center; margin: 30px 0;">
  <a href="{{dashboard_link}}" class="button">Open your dashboard</a>
</p>
<p style="font-size: 13px; color: #666;">If the button doesn't work, copy and paste this link into your browser:<br>
<span style="word-break: break-all;">{{dashboard_link}}</span></p>`,
    body_text: `You have new gallery access

Hi {{customer_name}},

Your photographer just gave you access to {{gallery_count}} new gallery (or galleries) on your account:

{{gallery_list_text}}

Open your dashboard: {{dashboard_link}}`,
  },
  de: {
    subject: 'Neue Galerie in deinem Konto verfügbar',
    body_html: `<h2>Du hast Zugriff auf neue Galerien</h2>
<p>Hallo {{customer_name}},</p>
{{#if singular}}<p>Dein Fotograf hat dir gerade Zugriff auf eine neue Galerie in deinem Konto gegeben:</p>{{/if}}{{#if multiple}}<p>Dein Fotograf hat dir gerade Zugriff auf {{gallery_count}} neue Galerien in deinem Konto gegeben:</p>{{/if}}
{{gallery_list_html}}
<p style="text-align: center; margin: 30px 0;">
  <a href="{{dashboard_link}}" class="button">Zum Dashboard</a>
</p>
<p style="font-size: 13px; color: #666;">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
<span style="word-break: break-all;">{{dashboard_link}}</span></p>`,
    body_text: `Du hast Zugriff auf neue Galerien

Hallo {{customer_name}},

Dein Fotograf hat dir gerade Zugriff auf {{gallery_count}} neue Galerie(n) in deinem Konto gegeben:

{{gallery_list_text}}

Zum Dashboard: {{dashboard_link}}`,
  },
  fr: {
    subject: 'Nouvel accès galerie sur votre compte',
    body_html: `<h2>Vous avez accès à de nouvelles galeries</h2>
<p>Bonjour {{customer_name}},</p>
{{#if singular}}<p>Votre photographe vient de vous donner accès à une nouvelle galerie sur votre compte :</p>{{/if}}{{#if multiple}}<p>Votre photographe vient de vous donner accès à {{gallery_count}} nouvelles galeries sur votre compte :</p>{{/if}}
{{gallery_list_html}}
<p style="text-align: center; margin: 30px 0;">
  <a href="{{dashboard_link}}" class="button">Ouvrir mon tableau de bord</a>
</p>
<p style="font-size: 13px; color: #666;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
<span style="word-break: break-all;">{{dashboard_link}}</span></p>`,
    body_text: `Vous avez accès à de nouvelles galeries

Bonjour {{customer_name}},

Votre photographe vient de vous donner accès à {{gallery_count}} nouvelle(s) galerie(s) sur votre compte :

{{gallery_list_text}}

Tableau de bord : {{dashboard_link}}`,
  },
  nl: {
    subject: 'Nieuwe galerij toegevoegd aan uw account',
    body_html: `<h2>U heeft toegang tot nieuwe galerijen</h2>
<p>Hallo {{customer_name}},</p>
{{#if singular}}<p>Uw fotograaf heeft u zojuist toegang gegeven tot een nieuwe galerij in uw account:</p>{{/if}}{{#if multiple}}<p>Uw fotograaf heeft u zojuist toegang gegeven tot {{gallery_count}} nieuwe galerijen in uw account:</p>{{/if}}
{{gallery_list_html}}
<p style="text-align: center; margin: 30px 0;">
  <a href="{{dashboard_link}}" class="button">Open uw dashboard</a>
</p>
<p style="font-size: 13px; color: #666;">Werkt de knop niet? Kopieer dan deze link in uw browser:<br>
<span style="word-break: break-all;">{{dashboard_link}}</span></p>`,
    body_text: `U heeft toegang tot nieuwe galerijen

Hallo {{customer_name}},

Uw fotograaf heeft u zojuist toegang gegeven tot {{gallery_count}} nieuwe galerij(en) in uw account:

{{gallery_list_text}}

Dashboard: {{dashboard_link}}`,
  },
  pt: {
    subject: 'Nova galeria disponível em sua conta',
    body_html: `<h2>Você tem acesso a novas galerias</h2>
<p>Olá {{customer_name}},</p>
{{#if singular}}<p>Seu fotógrafo acabou de lhe dar acesso a uma nova galeria em sua conta:</p>{{/if}}{{#if multiple}}<p>Seu fotógrafo acabou de lhe dar acesso a {{gallery_count}} novas galerias em sua conta:</p>{{/if}}
{{gallery_list_html}}
<p style="text-align: center; margin: 30px 0;">
  <a href="{{dashboard_link}}" class="button">Abrir meu painel</a>
</p>
<p style="font-size: 13px; color: #666;">Se o botão não funcionar, copie este link no navegador:<br>
<span style="word-break: break-all;">{{dashboard_link}}</span></p>`,
    body_text: `Você tem acesso a novas galerias

Olá {{customer_name}},

Seu fotógrafo acabou de lhe dar acesso a {{gallery_count}} nova(s) galeria(s) em sua conta:

{{gallery_list_text}}

Painel: {{dashboard_link}}`,
  },
  ru: {
    subject: 'Новая галерея доступна в вашем аккаунте',
    body_html: `<h2>У вас новый доступ к галереям</h2>
<p>Здравствуйте, {{customer_name}}!</p>
{{#if singular}}<p>Ваш фотограф только что предоставил вам доступ к новой галерее в вашем аккаунте:</p>{{/if}}{{#if multiple}}<p>Ваш фотограф только что предоставил вам доступ к {{gallery_count}} новым галереям в вашем аккаунте:</p>{{/if}}
{{gallery_list_html}}
<p style="text-align: center; margin: 30px 0;">
  <a href="{{dashboard_link}}" class="button">Открыть мой кабинет</a>
</p>
<p style="font-size: 13px; color: #666;">Если кнопка не работает, скопируйте эту ссылку в браузер:<br>
<span style="word-break: break-all;">{{dashboard_link}}</span></p>`,
    body_text: `У вас новый доступ к галереям

Здравствуйте, {{customer_name}}!

Ваш фотограф только что предоставил вам доступ к {{gallery_count}} новым галереям в вашем аккаунте:

{{gallery_list_text}}

Личный кабинет: {{dashboard_link}}`,
  },
};

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  const existing = await knex('email_templates')
    .where({ template_key: 'customer_gallery_assigned' })
    .first();
  if (existing) {
    console.log('  customer_gallery_assigned template already exists, skipping insert');
    return;
  }

  // Detect schema variant (legacy per-column vs normalized translations).
  // Newer installs have the email_template_translations table from
  // migration 075; older ones might still have subject_en/de/... columns
  // and NOT NULL constraints on the legacy columns. Cover both.
  const cols = await knex('email_templates').columnInfo();
  const hasTranslationsTable = await knex.schema.hasTable('email_template_translations');

  const enContent = TRANSLATIONS.en;

  // Build the master row. category/subcategory/feature_flag columns
  // were added in migration 098 — guard so this migration works on
  // a slightly older install too.
  const masterRow = {
    template_key: 'customer_gallery_assigned',
    variables: JSON.stringify([
      'customer_name',
      'gallery_count',
      'singular',
      'multiple',
      'gallery_list_html',
      'gallery_list_text',
      'dashboard_link',
    ]),
  };
  if ('category' in cols)     masterRow.category = 'customers';
  if ('subcategory' in cols)  masterRow.subcategory = null;
  if ('feature_flag' in cols) masterRow.feature_flag = 'customerPortal';
  if ('created_at' in cols)   masterRow.created_at = new Date();
  if ('updated_at' in cols)   masterRow.updated_at = new Date();

  // Populate any legacy subject_*/body_html_*/body_text_* columns the
  // schema still carries. Fallback content for non-en locales is the
  // English string — the translations table below has the real
  // per-locale copy. This only matters if the install hasn't run
  // migration 075 yet, which is rare but possible.
  for (const colName of Object.keys(cols)) {
    if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = enContent.subject;
    } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = enContent.body_html;
    } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = enContent.body_text;
    }
  }

  const inserted = await knex('email_templates').insert(masterRow).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (hasTranslationsTable && templateId) {
    for (const [language, content] of Object.entries(TRANSLATIONS)) {
      await knex('email_template_translations').insert({
        template_id: templateId,
        language,
        subject: content.subject,
        body_html: content.body_html,
        body_text: content.body_text,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }

  console.log('  customer_gallery_assigned template inserted with 6 translations');
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: 'customer_gallery_assigned' }).del();
};
