/**
 * Before/after rendering scenarios for migration 378, shared by the SQLite
 * and the PostgreSQL suite: adding pt content must not change what a
 * recipient in any other language gets. Rendering goes through the real
 * processTemplate, so its own fallbacks (requested language → en → any row →
 * legacy columns, field by field) decide what "unchanged" means.
 *
 * `ctx()` returns { db, processTemplate, migration } once the suite has booted.
 */
function definePtTemplateRepairScenarios(ctx) {
  const vars = { transfer_title: 'Hochzeit Müller', download_url: 'https://example.test/t/abc', expires_at: '2026-12-01' };
  const LEGACY = {
    subject_en: '{{transfer_title}} — your files are ready', body_html_en: '<p>Download: {{download_url}}</p>', body_text_en: 'Download: {{download_url}}',
    subject_de: '{{transfer_title}} — Ihre Dateien', body_html_de: '<p>Herunterladen: {{download_url}}</p>', body_text_de: 'Herunterladen: {{download_url}}',
  };

  // Put a template into a known state: its legacy columns and exactly `rows`.
  async function setTemplate(templateKey, legacy, rows = []) {
    const { db } = ctx();
    let template = await db('email_templates').where({ template_key: templateKey }).first();
    if (!template) {
      await db('email_templates').insert({ template_key: templateKey, variables: '[]' });
      template = await db('email_templates').where({ template_key: templateKey }).first();
    }
    await db('email_template_translations').where({ template_id: template.id }).del();
    await db('email_templates').where({ id: template.id }).update(legacy);
    const now = new Date().toISOString();
    for (const row of rows) {
      await db('email_template_translations').insert({ template_id: template.id, created_at: now, updated_at: now, ...row });
    }
    return template;
  }

  async function render(templateKey, language) {
    const { db, processTemplate } = ctx();
    const template = await db('email_templates').where({ template_key: templateKey }).first();
    const { subject, htmlBody, textBody } = await processTemplate(template, vars, language);
    return { subject, htmlBody, textBody };
  }

  const renderAll = async (templateKey, languages) => Object.fromEntries(
    await Promise.all(languages.map(async (language) => [language, await render(templateKey, language)])),
  );

  it('keeps English and German mails when an empty pt row already existed', async () => {
    await setTemplate('transfer_ready', LEGACY, [{ language: 'pt', subject: '', body_html: '', body_text: '' }]);

    const before = await renderAll('transfer_ready', ['en', 'de', 'fr']);
    await ctx().migration.up(ctx().db);
    expect(await renderAll('transfer_ready', ['en', 'de', 'fr'])).toEqual(before);
    expect(before.de.subject).toContain('Ihre Dateien');
    const pt = await render('transfer_ready', 'pt');
    expect(pt.subject).toContain('Hochzeit Müller');
    expect(pt.subject).not.toBe(before.en.subject);
  });

  it('keeps the English body of a German legacy template that only has a German subject', async () => {
    await setTemplate('transfer_request', {
      subject_en: 'Please upload — {{transfer_title}}', body_html_en: '<p>Upload here: {{download_url}}</p>', body_text_en: 'Upload here: {{download_url}}',
      subject_de: 'Bitte hochladen — {{transfer_title}}', body_html_de: '', body_text_de: '',
    });
    const before = await renderAll('transfer_request', ['en', 'de']);
    await ctx().migration.up(ctx().db);
    const after = await renderAll('transfer_request', ['en', 'de']);
    expect(after).toEqual(before);
    expect(after.de.subject).toContain('Bitte hochladen');
    expect(after.de.htmlBody).toContain('https://example.test/t/abc');
  });

  // The only row is an admin's Russian or Slovenian text: every language
  // without a row of its own was served that row, not the legacy columns.
  it.each([
    ['ru', 'transfer_files_received', 'Файлы получены — {{transfer_title}}'],
    ['sl', 'transfer_link_expired', 'Povezava je potekla — {{transfer_title}}'],
  ])('keeps every other language on a lone customised %s row', async (language, templateKey, subject) => {
    await setTemplate(templateKey, LEGACY, [{ language, subject, body_html: `<p>${language}: {{download_url}}</p>`, body_text: `${language}: {{download_url}}` }]);

    const before = await renderAll(templateKey, ['en', 'de', 'fr', language]);
    expect(before.en.subject).toBe(subject.replace('{{transfer_title}}', vars.transfer_title));
    await ctx().migration.up(ctx().db);
    expect(await renderAll(templateKey, ['en', 'de', 'fr', language])).toEqual(before);
    expect((await render(templateKey, 'pt')).subject).not.toBe(before.en.subject);
  });

  it('falls back to the oldest translation when neither the language nor English has one', async () => {
    // pt sorts before sl in the (template_id, language) index; the fallback
    // must not depend on which row the engine happens to list first.
    await setTemplate('transfer_ready', LEGACY, [
      { language: 'sl', subject: 'Slovenski naslov', body_html: '<p>sl</p>', body_text: 'sl' },
      { language: 'pt', subject: 'Assunto em português', body_html: '<p>pt</p>', body_text: 'pt' },
    ]);
    expect((await render('transfer_ready', 'en')).subject).toBe('Slovenski naslov');
    expect((await render('transfer_ready', 'fr')).subject).toBe('Slovenski naslov');
  });
}

module.exports = { definePtTemplateRepairScenarios };
