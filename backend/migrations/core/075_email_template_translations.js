/**
 * Migration to create email_template_translations table
 * Moves from per-column language support (subject_en, subject_de) to a
 * normalized translations table where each language is a row.
 * This allows adding new languages without schema changes.
 */
exports.up = async function(knex) {
  // 1. Create the email_template_translations table
  await knex.schema.createTable('email_template_translations', (table) => {
    table.increments('id').primary();
    table.integer('template_id').unsigned().notNullable()
      .references('id').inTable('email_templates').onDelete('CASCADE');
    table.string('language', 10).notNullable();
    table.text('subject');
    table.text('body_html');
    table.text('body_text');
    table.datetime('created_at').defaultTo(knex.fn.now());
    table.datetime('updated_at').defaultTo(knex.fn.now());
    table.unique(['template_id', 'language']);
  });

  console.log('Created email_template_translations table');

  // 2. Migrate existing data from email_templates columns into rows
  const templates = await knex('email_templates').select('*');
  const columnInfo = await knex('email_templates').columnInfo();
  const hasLangColumns = !!columnInfo.subject_en;

  for (const template of templates) {
    // Extract EN translation
    const enSubject = hasLangColumns
      ? (template.subject_en || template.subject || '')
      : (template.subject || '');
    const enHtml = hasLangColumns
      ? (template.body_html_en || template.body_html || '')
      : (template.body_html || '');
    const enText = hasLangColumns
      ? (template.body_text_en || template.body_text || '')
      : (template.body_text || '');

    // Insert EN translation
    if (enSubject || enHtml) {
      await knex('email_template_translations').insert({
        template_id: template.id,
        language: 'en',
        subject: enSubject,
        body_html: enHtml,
        body_text: enText,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    // Extract DE translation (only if lang columns exist)
    if (hasLangColumns) {
      const deSubject = template.subject_de || '';
      const deHtml = template.body_html_de || '';
      const deText = template.body_text_de || '';

      // Only insert if DE content differs from EN or has content
      if (deSubject || deHtml) {
        await knex('email_template_translations').insert({
          template_id: template.id,
          language: 'de',
          subject: deSubject,
          body_html: deHtml,
          body_text: deText,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }
  }

  console.log(`Migrated ${templates.length} templates to translations table`);

  // 3. Seed NL, PT, RU translations for customer-facing templates
  // Look up template IDs
  const customerTemplates = await knex('email_templates')
    .whereIn('template_key', [
      'gallery_created', 'expiration_warning', 'gallery_expired', 'archive_complete'
    ])
    .select('id', 'template_key');

  const templateMap = {};
  customerTemplates.forEach(t => { templateMap[t.template_key] = t.id; });

  const seedTranslations = [];

  // --- gallery_created ---
  if (templateMap.gallery_created) {
    const id = templateMap.gallery_created;
    seedTranslations.push(
      {
        template_id: id, language: 'nl',
        subject: 'Uw fotogalerij is klaar!',
        body_html: `<h2>Galerij succesvol aangemaakt</h2>
<p>Beste {{host_name}},</p>
<p>Uw fotogalerij "{{event_name}}" is succesvol aangemaakt!</p>
<p><strong>Galerij details:</strong></p>
<ul>
  <li>Evenementdatum: {{event_date}}</li>
  <li>Galerij link: <a href="{{gallery_link}}">{{gallery_link}}</a></li>
  <li>Wachtwoord: {{gallery_password}}</li>
  <li>Verloopt op: {{expiry_date}}</li>
</ul>
<p>Deel deze link en het wachtwoord met uw gasten zodat zij de foto's kunnen bekijken en downloaden.</p>
{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}`,
        body_text: `Galerij succesvol aangemaakt\n\nBeste {{host_name}},\n\nUw fotogalerij "{{event_name}}" is succesvol aangemaakt!\n\nGalerij link: {{gallery_link}}\nWachtwoord: {{gallery_password}}\nVerloopt op: {{expiry_date}}`,
      },
      {
        template_id: id, language: 'pt',
        subject: 'Sua galeria de fotos está pronta!',
        body_html: `<h2>Galeria criada com sucesso</h2>
<p>Prezado(a) {{host_name}},</p>
<p>Sua galeria de fotos "{{event_name}}" foi criada com sucesso!</p>
<p><strong>Detalhes da galeria:</strong></p>
<ul>
  <li>Data do evento: {{event_date}}</li>
  <li>Link da galeria: <a href="{{gallery_link}}">{{gallery_link}}</a></li>
  <li>Senha: {{gallery_password}}</li>
  <li>Expira em: {{expiry_date}}</li>
</ul>
<p>Compartilhe este link e senha com seus convidados para que possam visualizar e baixar as fotos.</p>
{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}`,
        body_text: `Galeria criada com sucesso\n\nPrezado(a) {{host_name}},\n\nSua galeria de fotos "{{event_name}}" foi criada com sucesso!\n\nLink da galeria: {{gallery_link}}\nSenha: {{gallery_password}}\nExpira em: {{expiry_date}}`,
      },
      {
        template_id: id, language: 'ru',
        subject: 'Ваша фотогалерея готова!',
        body_html: `<h2>Галерея успешно создана</h2>
<p>Уважаемый(ая) {{host_name}},</p>
<p>Ваша фотогалерея "{{event_name}}" была успешно создана!</p>
<p><strong>Детали галереи:</strong></p>
<ul>
  <li>Дата события: {{event_date}}</li>
  <li>Ссылка на галерею: <a href="{{gallery_link}}">{{gallery_link}}</a></li>
  <li>Пароль: {{gallery_password}}</li>
  <li>Срок действия: {{expiry_date}}</li>
</ul>
<p>Поделитесь этой ссылкой и паролем с вашими гостями, чтобы они могли просматривать и скачивать фотографии.</p>
{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}`,
        body_text: `Галерея успешно создана\n\nУважаемый(ая) {{host_name}},\n\nВаша фотогалерея "{{event_name}}" была успешно создана!\n\nСсылка: {{gallery_link}}\nПароль: {{gallery_password}}\nСрок действия: {{expiry_date}}`,
      },
    );
  }

  // --- expiration_warning ---
  if (templateMap.expiration_warning) {
    const id = templateMap.expiration_warning;
    seedTranslations.push(
      {
        template_id: id, language: 'nl',
        subject: 'Uw fotogalerij verloopt binnenkort',
        body_html: `<h2>Galerij verloopt binnenkort</h2>
<p>Beste {{host_name}},</p>
<p>Uw fotogalerij "{{event_name}}" verloopt over {{days_remaining}} dagen.</p>
<p>Na het verlopen wordt de galerij gearchiveerd en is niet meer toegankelijk voor gasten.</p>
<p><a href="{{gallery_link}}">Galerij bezoeken</a></p>`,
        body_text: `Galerij verloopt binnenkort\n\nBeste {{host_name}},\n\nUw fotogalerij "{{event_name}}" verloopt over {{days_remaining}} dagen.\n\nGalerij: {{gallery_link}}`,
      },
      {
        template_id: id, language: 'pt',
        subject: 'Sua galeria de fotos expira em breve',
        body_html: `<h2>Galeria expirando em breve</h2>
<p>Prezado(a) {{host_name}},</p>
<p>Sua galeria de fotos "{{event_name}}" expirará em {{days_remaining}} dias.</p>
<p>Após a expiração, a galeria será arquivada e não estará mais acessível aos convidados.</p>
<p><a href="{{gallery_link}}">Visitar galeria</a></p>`,
        body_text: `Galeria expirando em breve\n\nPrezado(a) {{host_name}},\n\nSua galeria de fotos "{{event_name}}" expirará em {{days_remaining}} dias.\n\nGaleria: {{gallery_link}}`,
      },
      {
        template_id: id, language: 'ru',
        subject: 'Срок действия вашей фотогалереи скоро истекает',
        body_html: `<h2>Срок действия галереи истекает</h2>
<p>Уважаемый(ая) {{host_name}},</p>
<p>Срок действия вашей фотогалереи "{{event_name}}" истекает через {{days_remaining}} дней.</p>
<p>После истечения срока галерея будет архивирована и станет недоступна для гостей.</p>
<p><a href="{{gallery_link}}">Перейти в галерею</a></p>`,
        body_text: `Срок действия галереи истекает\n\nУважаемый(ая) {{host_name}},\n\nСрок действия вашей фотогалереи "{{event_name}}" истекает через {{days_remaining}} дней.\n\nГалерея: {{gallery_link}}`,
      },
    );
  }

  // --- gallery_expired ---
  if (templateMap.gallery_expired) {
    const id = templateMap.gallery_expired;
    seedTranslations.push(
      {
        template_id: id, language: 'nl',
        subject: 'Uw fotogalerij {{event_name}} is verlopen',
        body_html: `<h2>Galerij verlopen</h2>
<p>Beste {{host_name}},</p>
<p>Uw fotogalerij "{{event_name}}" is verlopen en niet meer toegankelijk.</p>
<p>De foto's zijn gearchiveerd. Als u toegang nodig heeft, neem dan contact op met de beheerder via {{admin_email}}.</p>`,
        body_text: `Galerij verlopen\n\nBeste {{host_name}},\n\nUw fotogalerij "{{event_name}}" is verlopen en niet meer toegankelijk.\n\nNeem contact op met: {{admin_email}}`,
      },
      {
        template_id: id, language: 'pt',
        subject: 'Sua galeria de fotos {{event_name}} expirou',
        body_html: `<h2>Galeria expirada</h2>
<p>Prezado(a) {{host_name}},</p>
<p>Sua galeria de fotos "{{event_name}}" expirou e não está mais acessível.</p>
<p>As fotos foram arquivadas. Se precisar de acesso, entre em contato com o administrador em {{admin_email}}.</p>`,
        body_text: `Galeria expirada\n\nPrezado(a) {{host_name}},\n\nSua galeria de fotos "{{event_name}}" expirou e não está mais acessível.\n\nContato: {{admin_email}}`,
      },
      {
        template_id: id, language: 'ru',
        subject: 'Срок действия фотогалереи {{event_name}} истёк',
        body_html: `<h2>Срок действия галереи истёк</h2>
<p>Уважаемый(ая) {{host_name}},</p>
<p>Срок действия вашей фотогалереи "{{event_name}}" истёк, и она больше недоступна.</p>
<p>Фотографии были архивированы. Если вам нужен доступ, свяжитесь с администратором: {{admin_email}}.</p>`,
        body_text: `Срок действия галереи истёк\n\nУважаемый(ая) {{host_name}},\n\nСрок действия вашей фотогалереи "{{event_name}}" истёк.\n\nКонтакт: {{admin_email}}`,
      },
    );
  }

  // --- archive_complete ---
  if (templateMap.archive_complete) {
    const id = templateMap.archive_complete;
    seedTranslations.push(
      {
        template_id: id, language: 'nl',
        subject: 'Archivering voltooid: {{event_name}}',
        body_html: `<h2>Archivering voltooid</h2>
<p>Beste {{host_name}},</p>
<p>De fotogalerij "{{event_name}}" is succesvol gearchiveerd.</p>
<p><strong>Archief details:</strong></p>
<ul>
  <li>Aantal foto's: {{photo_count}}</li>
  <li>Archiefgrootte: {{archive_size}}</li>
  <li>Archiefdatum: {{archive_date}}</li>
</ul>`,
        body_text: `Archivering voltooid\n\nBeste {{host_name}},\n\nDe fotogalerij "{{event_name}}" is succesvol gearchiveerd.\n\nAantal foto's: {{photo_count}}\nGrootte: {{archive_size}}`,
      },
      {
        template_id: id, language: 'pt',
        subject: 'Arquivamento concluído: {{event_name}}',
        body_html: `<h2>Arquivamento concluído</h2>
<p>Prezado(a) {{host_name}},</p>
<p>A galeria de fotos "{{event_name}}" foi arquivada com sucesso.</p>
<p><strong>Detalhes do arquivo:</strong></p>
<ul>
  <li>Número de fotos: {{photo_count}}</li>
  <li>Tamanho do arquivo: {{archive_size}}</li>
  <li>Data do arquivamento: {{archive_date}}</li>
</ul>`,
        body_text: `Arquivamento concluído\n\nPrezado(a) {{host_name}},\n\nA galeria de fotos "{{event_name}}" foi arquivada com sucesso.\n\nFotos: {{photo_count}}\nTamanho: {{archive_size}}`,
      },
      {
        template_id: id, language: 'ru',
        subject: 'Архивация завершена: {{event_name}}',
        body_html: `<h2>Архивация завершена</h2>
<p>Уважаемый(ая) {{host_name}},</p>
<p>Фотогалерея "{{event_name}}" была успешно архивирована.</p>
<p><strong>Детали архива:</strong></p>
<ul>
  <li>Количество фото: {{photo_count}}</li>
  <li>Размер архива: {{archive_size}}</li>
  <li>Дата архивации: {{archive_date}}</li>
</ul>`,
        body_text: `Архивация завершена\n\nУважаемый(ая) {{host_name}},\n\nФотогалерея "{{event_name}}" была успешно архивирована.\n\nФото: {{photo_count}}\nРазмер: {{archive_size}}`,
      },
    );
  }

  // Insert all seed translations
  const now = new Date();
  for (const trans of seedTranslations) {
    trans.created_at = now;
    trans.updated_at = now;
    await knex('email_template_translations').insert(trans);
  }

  console.log(`Seeded ${seedTranslations.length} translations for customer-facing templates`);
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('email_template_translations');
};
