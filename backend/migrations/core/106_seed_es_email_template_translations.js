/**
 * Migration: seed Spanish (es) email-template translations (#510).
 *
 * Contributed by @AloePacci on issue #510. Covers the four
 * customer-facing gallery delivery templates that already had
 * en/de/nl/pt/ru rows from migration 075. Templates without an `es`
 * row (admin_*, backup_*, restore_*, customer_*, version_update_*)
 * continue to fall back to `en` via the resolution chain in
 * emailProcessor.processTemplate — no functional gap, just untranslated
 * copy until someone fills them in.
 *
 * Same idempotency pattern as 099_seed_missing_email_template_translations:
 * checks (template_id, language) before inserting so re-runs are safe.
 */

const TRANSLATIONS = {
  gallery_created: {
    es: {
      subject: 'Su galería de fotos está lista!',
      body_html: `<h2>Galería creada con éxito</h2>
<p>Estimado {{host_name}},</p>
<p>Su galería de fotos "{{event_name}}" ha sido creada con éxito!</p>
<p><strong>Detalles de la galería:</strong></p>
<ul>
  <li>Fecha del evento: {{event_date}}</li>
  <li>Enlace de la galería: <a href="{{gallery_link}}">{{gallery_link}}</a></li>
  <li>Contraseña: {{gallery_password}}</li>
  <li>Expira en: {{expiry_date}}</li>
</ul>
<p>Comparta este enlace y contraseña con sus invitados para que puedan ver y descargar las fotos.</p>
{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}`,
      body_text: 'Galería creada con éxito\n\nEstimado {{host_name}},\n\nSu galería de fotos "{{event_name}}" ha sido creada con éxito!\n\nEnlace de la galería: {{gallery_link}}\nContraseña: {{gallery_password}}\nExpira en: {{expiry_date}}',
    },
  },

  expiration_warning: {
    es: {
      subject: 'Su galería de fotos expirará pronto',
      body_html: `<h2>Galería expirando pronto</h2>
<p>Estimado {{host_name}},</p>
<p>Su galería de fotos "{{event_name}}" expirará en {{days_remaining}} días.</p>
<p>Después de la expiración, la galería será archivada y ya no estará accesible para los invitados.</p>
<p><a href="{{gallery_link}}">Visitar galería</a></p>`,
      body_text: 'Galería expirando pronto\n\nEstimado {{host_name}},\n\nSu galería de fotos "{{event_name}}" expirará en {{days_remaining}} días.\n\nGalería: {{gallery_link}}',
    },
  },

  gallery_expired: {
    es: {
      subject: 'Su galería de fotos está caducada',
      body_html: `<h2>Galería vencida</h2>
<p>Estimado {{host_name}},</p>
<p>Su galería de fotos "{{event_name}}" ha caducado y por tanto ya no es accesible.</p>
<p>Las fotos han sido archivadas. Si necesita acceso, por favor póngase en contacto con el administrador a través de {{admin_email}}.</p>`,
      body_text: 'Galería caducada\n\nEstimado {{host_name}},\n\nSu galería de fotos "{{event_name}}" ha caducado y ya no está accesible.\n\nContacto: {{admin_email}}',
    },
  },

  archive_complete: {
    es: {
      subject: 'Archivado completado: {{event_name}}',
      body_html: `<h2>Archivado completado</h2>
<p>Estimado {{host_name}},</p>
<p>Su galería de fotos "{{event_name}}" ha sido archivada con éxito.</p>
<p><strong>Detalles del archivo:</strong></p>
<ul>
  <li>Número de fotos: {{photo_count}}</li>
  <li>Tamaño del archivo: {{archive_size}}</li>
  <li>Fecha del archivado: {{archive_date}}</li>
</ul>`,
      body_text: 'Archivado completado\n\nEstimado {{host_name}},\n\nSu galería de fotos "{{event_name}}" ha sido archivada con éxito.\n\nFotos: {{photo_count}}\nTamaño: {{archive_size}}',
    },
  },
};

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;

  const rows = await knex('email_templates')
    .whereIn('template_key', Object.keys(TRANSLATIONS))
    .select('id', 'template_key');
  const keyToId = Object.fromEntries(rows.map((r) => [r.template_key, r.id]));

  let inserted = 0;
  let skipped = 0;

  for (const [key, perLocale] of Object.entries(TRANSLATIONS)) {
    const templateId = keyToId[key];
    if (!templateId) continue;

    for (const [language, content] of Object.entries(perLocale)) {
      const existing = await knex('email_template_translations')
        .where({ template_id: templateId, language })
        .first();
      if (existing) {
        skipped += 1;
        continue;
      }
      await knex('email_template_translations').insert({
        template_id: templateId,
        language,
        subject: content.subject,
        body_html: content.body_html,
        body_text: content.body_text,
        created_at: new Date(),
        updated_at: new Date(),
      });
      inserted += 1;
    }
  }

  console.log(`106_seed_es_email_template_translations: inserted=${inserted}, skipped=${skipped}`);
};

exports.down = async function(knex) {
  // No-op: same rationale as 099. An admin may have hand-edited the
  // `es` rows in the Templates UI after this migration ran, and we
  // can't tell apart inserted-by-us rows from edited-by-admin rows.
  // Rollback by hand if you truly need to drop them.
};
