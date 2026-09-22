/**
 * The pre-publication check of a contract template (#1445, plan slice 3).
 *
 * POST /:id/publish-check answers `{ ok, pageCount, itemPages, findings }`:
 * each problem with a code, a severity and where it is (clause position,
 * language, placeholder key, attachment), plus a dry run of the real render
 * with the pages each clause lands on. Publishing runs the same check and
 * refuses on any error with every finding in `details.findings` — and a
 * refused publish leaves the draft and its lock version untouched.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let token;
let templatesApp;
let attachmentsApp;
let block;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const url = (p = '') => `/api/admin/contract-templates${p}`;

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A template whose draft holds `draft` (items, intro, …); returns its detail. */
async function templateWith(draft, name = `T ${Math.random()}`) {
  const created = await ok(request(templatesApp).post(url()).set(auth).send({ name }));
  return ok(request(templatesApp).put(url(`/${created.template.id}/draft`)).set(auth)
    .send({ lockVersion: created.template.lockVersion, ...draft }));
}

const check = (id) => ok(request(templatesApp).post(url(`/${id}/publish-check`)).set(auth));
const codes = (result) => result.findings.map((f) => f.code);
const text = (body, extra = {}) => ({ kind: 'text', section: 'closing', heading: 'Zusatz', body, ...extra });

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'contracts', value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
  attachmentsApp = buildRouteApp('/api/admin/document-attachments', require('../../src/routes/adminDocumentAttachments'));
  // The standard template seeds the system blocks.
  await ok(request(templatesApp).get(url()).set(auth));
  block = await db('contract_blocks').where({ is_system: true, is_active: true }).orderBy('id').first();
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a clean draft passes, with a page count and the page each clause starts on', async () => {
  const saved = await templateWith({
    items: [
      { kind: 'block', blockId: block.id },
      text({ de: 'Freitext {{customer_name}}', en: 'Free text {{customer_name}}' }),
    ],
  });
  const result = await check(saved.template.id);
  expect(result.ok).toBe(true);
  expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(result.pageCount).toBeGreaterThanOrEqual(2);
  expect(result.itemPages.map((p) => p.position)).toEqual([1, 2]);
  for (const page of result.itemPages) {
    expect(page.firstPage).toBeGreaterThanOrEqual(1);
    expect(page.lastPage).toBeGreaterThanOrEqual(page.firstPage);
    // The signature page is last and holds no clause.
    expect(page.lastPage).toBeLessThan(result.pageCount);
  }
});

test('an empty draft: NO_CLAUSES', async () => {
  const saved = await templateWith({ items: [] });
  const result = await check(saved.template.id);
  expect(result.ok).toBe(false);
  expect(codes(result)).toContain('NO_CLAUSES');
});

test('unknown placeholders are located by clause, language and key', async () => {
  const saved = await templateWith({
    introText: { en: 'Hi {{custmer_name}}' },
    items: [{ kind: 'block', blockId: block.id }, text({ de: 'Am {{evnt_date}}', en: 'On {{event_date}}' })],
  });
  const result = await check(saved.template.id);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'PLACEHOLDER_UNKNOWN', severity: 'error', itemPosition: 2, locale: 'de', key: 'evnt_date' }),
    expect.objectContaining({ code: 'PLACEHOLDER_UNKNOWN', severity: 'error', field: 'intro', locale: 'en', key: 'custmer_name' }),
  ]));
});

test('nested and unclosed conditionals are refused', async () => {
  const saved = await templateWith({
    items: [
      text({ de: '{{#if event_name}}a {{#if event_date}}b{{/if}}{{/if}}', en: 'x' }),
      text({ de: '{{#if event_name}}offen', en: 'x' }),
    ],
  });
  const result = await check(saved.template.id);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'CONDITIONAL_NESTED', itemPosition: 1, locale: 'de' }),
    expect.objectContaining({ code: 'CONDITIONAL_UNCLOSED', itemPosition: 2, locale: 'de' }),
  ]));
});

test('an empty free-text section and an archived block are located', async () => {
  const [other] = await db('contract_blocks').where({ is_system: true }).whereNot({ id: block.id }).orderBy('id').limit(1);
  const saved = await templateWith({ items: [text({}), { kind: 'block', blockId: other.id }] });
  await db('contract_blocks').where({ id: other.id }).update({ is_active: false });
  try {
    const result = await check(saved.template.id);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SECTION_EMPTY', severity: 'error', itemPosition: 1 }),
      expect.objectContaining({ code: 'BLOCK_ARCHIVED', severity: 'error', itemPosition: 2 }),
    ]));
  } finally {
    await db('contract_blocks').where({ id: other.id }).update({ is_active: true });
  }
});

test('a clause in one of EN and DE only is a warning, not an error', async () => {
  const saved = await templateWith({ items: [text({ de: 'Nur Deutsch' })] });
  const result = await check(saved.template.id);
  expect(result.ok).toBe(true);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'LOCALE_INCOMPLETE', severity: 'warning', itemPosition: 1, locale: 'en' }),
  ]));
});

test('attachments: archived, missing and changed files are reported', async () => {
  const pdf = async (w) => {
    const doc = await PDFDocument.create();
    doc.addPage([w, w]);
    return Buffer.from(await doc.save());
  };
  const upload = async (buffer, name) => (await ok(request(attachmentsApp).post('/api/admin/document-attachments')
    .set(auth).field('name', name).attach('file', buffer, { filename: `${name}.pdf`, contentType: 'application/pdf' }))).attachment;
  const archived = await upload(await pdf(201), 'Archived');
  const missing = await upload(await pdf(202), 'Missing');
  const changed = await upload(await pdf(203), 'Changed');
  const saved = await templateWith({
    items: [text({ de: 'a', en: 'a' })],
    attachments: [archived, missing, changed].map((a) => ({ attachmentId: a.id, delivery: 'merged' })),
  });
  await ok(request(attachmentsApp).post(`/api/admin/document-attachments/${archived.id}/archive`).set(auth));
  const file = (a) => path.join(process.env.STORAGE_PATH, 'business-docs', 'attachments', `${a.sha256}.pdf`);
  fs.renameSync(file(missing), `${file(missing)}.away`);
  fs.appendFileSync(file(changed), '% tampered\n');
  try {
    const result = await check(saved.template.id);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ATTACHMENT_ARCHIVED', attachmentId: archived.id }),
      expect.objectContaining({ code: 'ATTACHMENT_MISSING', attachmentId: missing.id }),
      expect.objectContaining({ code: 'ATTACHMENT_CHANGED', attachmentId: changed.id }),
    ]));
    // The dry run still renders, without the file it could not read.
    expect(codes(result)).not.toContain('RENDER_FAILED');
  } finally {
    fs.renameSync(`${file(missing)}.away`, file(missing));
  }
});

test('a theme font that is gone and a logo file that is gone are warnings', async () => {
  await db('pdf_themes').insert({ scope: 'contract', settings: JSON.stringify({ fontFamily: 'NoSuchFamily' }) })
    .catch(() => db('pdf_themes').where({ scope: 'contract' }).update({ settings: JSON.stringify({ fontFamily: 'NoSuchFamily' }) }));
  await db('business_profile').update({ logo_path: 'uploads/logos/gone.png' });
  try {
    const saved = await templateWith({ items: [text({ de: 'a', en: 'a' })] });
    const result = await check(saved.template.id);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FONT_MISSING', severity: 'warning', key: 'NoSuchFamily' }),
      expect.objectContaining({ code: 'LOGO_MISSING', severity: 'warning' }),
    ]));
  } finally {
    await db('pdf_themes').where({ scope: 'contract' }).del();
    await db('business_profile').update({ logo_path: null });
  }
});

test('a long draft warns about its page count; a render that fails is an error', async () => {
  const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(400);
  const saved = await templateWith({ items: Array.from({ length: 10 }, () => text({ de: 'x', en: 'x' })) });
  // Written directly: the editor's request body is capped well below this.
  const draft = await db('contract_template_versions').where({ template_id: saved.template.id, status: 'draft' }).first();
  await db('contract_template_version_items').where({ version_id: draft.id })
    .update({ body_override: JSON.stringify({ de: long, en: long }) });
  const result = await check(saved.template.id);
  expect(result.pageCount).toBeGreaterThan(30);
  expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PAGE_COUNT_HIGH', severity: 'warning' })]));

  const pdfService = require('../../src/services/pdfService');
  const spy = jest.spyOn(pdfService, 'renderContractWithSlots').mockRejectedValue(new Error('boom'));
  try {
    const failed = await check(saved.template.id);
    expect(failed.ok).toBe(false);
    expect(codes(failed)).toContain('RENDER_FAILED');
  } finally {
    spy.mockRestore();
  }
});

test('a refused publish lists the findings and leaves the draft and its lock untouched', async () => {
  const saved = await templateWith({ items: [text({ de: 'Am {{evnt_date}}', en: 'On {{event_date}}' })] });
  const before = await db('contract_templates').where({ id: saved.template.id }).first();
  const draftBefore = await db('contract_template_versions').where({ template_id: saved.template.id, status: 'draft' }).first();

  const res = await request(templatesApp).post(url(`/${saved.template.id}/publish`)).set(auth)
    .send({ lockVersion: saved.template.lockVersion });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('TEMPLATE_INVALID');
  expect(res.body.details.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'PLACEHOLDER_UNKNOWN', itemPosition: 1, locale: 'de', key: 'evnt_date' }),
  ]));

  const after = await db('contract_templates').where({ id: saved.template.id }).first();
  expect(Number(after.lock_version)).toBe(Number(before.lock_version));
  expect(after.status).toBe(before.status);
  const draftAfter = await db('contract_template_versions').where({ template_id: saved.template.id, status: 'draft' }).first();
  expect(draftAfter.id).toBe(draftBefore.id);
  expect(await db('contract_template_version_items').where({ version_id: draftAfter.id }).count({ n: '*' }).first())
    .toEqual(expect.objectContaining({ n: expect.anything() }));
});

test('the check needs the template permission', async () => {
  const saved = await templateWith({ items: [text({ de: 'a', en: 'a' })] });
  const bcrypt = require('bcrypt');
  const inserted = await db('admin_users').insert({
    username: 'viewer', email: 'viewer@example.com', password_hash: await bcrypt.hash('x', 4),
    must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id');
  const viewerId = inserted[0]?.id ?? inserted[0];
  await assignAdminRole(db, viewerId, 'viewer').catch(() => {});
  const res = await request(templatesApp).post(url(`/${saved.template.id}/publish-check`))
    .set('Authorization', `Bearer ${mintAdminToken(viewerId)}`);
  expect(res.status).toBe(403);
});
