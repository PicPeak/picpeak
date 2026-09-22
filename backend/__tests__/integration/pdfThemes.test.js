/**
 * PDF themes and generated-document records (#1445).
 *
 * Real admin routes → services → SQLite with the full core-migration run
 * (helpers/crmDb). Pins:
 *   - every scope is listed with its resolved theme;
 *   - a saved scope reaches the document types, the scope row winning;
 *   - invalid settings and unknown scopes are refused;
 *   - a preview renders a real PDF with unsaved settings;
 *   - reading needs settings.view or settings.banking, changing needs
 *     settings.banking;
 *   - a sent quote's PDF is recorded with its sha256, pages and theme.
 */

const crypto = require('crypto');
const fs = require('fs');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

// Stored paths are relative to the storage root (storedPath.js).
const { toStoredPath: storedAs } = require('../../src/utils/storedPath');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let app;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  app = buildRouteApp('/api/admin/pdf-themes', require('../../src/routes/adminPdfThemes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('lists every scope with its resolved theme and the font families', async () => {
  const res = await request(app).get('/api/admin/pdf-themes').set(auth);
  expect(res.status).toBe(200);
  expect(res.body.themes.map((t) => t.scope)).toEqual(['default', 'quote', 'invoice', 'contract']);
  expect(res.body.themes.find((t) => t.scope === 'contract').resolved.titleSize).toBe(18);
  expect(res.body.fontFamilies).toContain('Jost');
});

test('a saved scope reaches the document types; the scope row wins', async () => {
  let res = await request(app).put('/api/admin/pdf-themes/default').set(auth)
    .send({ settings: { colors: { accent: '#123456' }, titleSize: 22 } });
  expect(res.status).toBe(200);
  res = await request(app).put('/api/admin/pdf-themes/contract').set(auth)
    .send({ settings: { footer: { mode: 'address' }, titleSize: 19 } });
  expect(res.status).toBe(200);

  const resolved = Object.fromEntries(res.body.themes.map((t) => [t.scope, t.resolved]));
  expect(resolved.quote.colors.accent).toBe('#123456');
  expect(resolved.quote.titleSize).toBe(22);
  expect(resolved.contract.colors.accent).toBe('#123456');
  expect(resolved.contract.titleSize).toBe(19);
  expect(resolved.contract.footer.mode).toBe('address');

  // An empty object clears a scope back to the next level.
  res = await request(app).put('/api/admin/pdf-themes/contract').set(auth).send({ settings: {} });
  expect(res.body.themes.find((t) => t.scope === 'contract').resolved.titleSize).toBe(22);
});

test('invalid settings and unknown scopes are refused', async () => {
  let res = await request(app).put('/api/admin/pdf-themes/quote').set(auth)
    .send({ settings: { colors: { text: 'red' } } });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('PDF_THEME_INVALID');

  res = await request(app).put('/api/admin/pdf-themes/letterhead').set(auth).send({ settings: {} });
  expect(res.status).toBe(400);
});

test.each(['quote', 'invoice', 'contract', 'default'])('previews a %s with unsaved settings', async (scope) => {
  const res = await request(app).post(`/api/admin/pdf-themes/${scope}/preview`).set(auth)
    .send({ settings: { titleSize: 24, footer: { mode: 'custom', text: 'Preview footer' } } })
    .buffer(true).parse(binary);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/pdf/);
  expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
});

test('reading needs settings.view or settings.banking; changing needs settings.banking', async () => {
  await assignAdminRole(db, adminId, 'viewer');
  try {
    const put = await request(app).put('/api/admin/pdf-themes/quote').set(auth).send({ settings: {} });
    expect(put.status).toBe(403);
    const preview = await request(app).post('/api/admin/pdf-themes/quote/preview').set(auth).send({});
    expect(preview.status).toBe(403);
  } finally {
    await assignAdminRole(db, adminId, 'super_admin');
  }
  const anonymous = await request(app).get('/api/admin/pdf-themes');
  expect(anonymous.status).toBe(401);
});

test('a sent quote records its PDF with sha256, pages and the theme it used', async () => {
  await request(app).put('/api/admin/pdf-themes/quote').set(auth)
    .send({ settings: { fontFamily: 'Jost' } }).expect(200);

  const quoteService = require('../../src/services/quoteService');
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId,
    currency: 'CHF',
    lineItems: [{ position: 1, quantity: 1, description: 'Portrait session', unit_price_minor: 50000, details_text: 'Eine Notiz' }],
  }, adminId);
  const { pdfPath } = await quoteService.sendQuote(quoteId, adminId);

  const rows = await db('generated_documents').where({ doc_type: 'quote', doc_id: quoteId });
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row.kind).toBe('sent');
  expect(row.path).toBe(storedAs(pdfPath));
  expect(row.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'));
  expect(Number(row.pages)).toBeGreaterThanOrEqual(1);
  const snapshot = JSON.parse(row.theme_snapshot);
  expect(snapshot.scope).toBe('quote');
  expect(snapshot.fontFamily).toBe('Jost');
  expect(snapshot.fontSha256.italic).toMatch(/^[0-9a-f]{64}$/);
});

test('layout settings save within their bounds and come back with readability warnings (#1445)', async () => {
  let res = await request(app).put('/api/admin/pdf-themes/contract').set(auth).send({
    settings: { layout: { margins: { left: 25, right: 15 }, addressWindow: false }, bodySize: 9, colors: { muted: '#bbbbbb' } },
  });
  expect(res.status).toBe(200);
  const contract = res.body.themes.find((t) => t.scope === 'contract');
  expect(contract.resolved.layout).toEqual({ margins: { left: 25, right: 15 }, addressWindow: false });
  expect(contract.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['CONTRAST_LOW', 'BODY_SIZE_SMALL']));

  res = await request(app).put('/api/admin/pdf-themes/contract').set(auth)
    .send({ settings: { layout: { margins: { left: 12 } } } });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('PDF_THEME_INVALID');

  res = await request(app).put('/api/admin/pdf-themes/contract').set(auth).send({ settings: {} });
  expect(res.body.themes.find((t) => t.scope === 'contract').warnings).toEqual([]);
});
