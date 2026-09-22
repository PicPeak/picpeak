/**
 * Uploaded PDF fonts (#1445, plan slice 9).
 *
 * A font is checked by content — TTF/OTF only, complete, within size, and
 * its own licence must allow embedding — and the admin must write a licence
 * note and confirm the right to embed it. It is stored under
 * business-docs/fonts (a backup path), a theme can use it as
 * `upload-<id>`, the same inputs render the same bytes with it, and an
 * archived font falls back to Helvetica, which the template check reports.
 * The retired free-text font path moves into an uploaded font once.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let token;
let app;
let templatesApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const FONTS = path.resolve(__dirname, '../../assets/fonts/Jost');
const regular = fs.readFileSync(path.join(FONTS, '400.ttf'));
const bold = fs.readFileSync(path.join(FONTS, '700.ttf'));
const italic = fs.readFileSync(path.join(FONTS, '400i.ttf'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A copy of `ttf` with OS/2 fsType set to `bits` (default: restricted licence embedding). */
function restricted(ttf, bits = 0x0002) {
  const out = Buffer.from(ttf);
  const tables = out.readUInt16BE(4);
  for (let i = 0; i < tables; i += 1) {
    const record = 12 + i * 16;
    if (out.toString('latin1', record, record + 4) === 'OS/2') {
      out.writeUInt16BE(bits, out.readUInt32BE(record + 8) + 8);
      return out;
    }
  }
  throw new Error('no OS/2 table');
}

function upload(files, fields = {}) {
  let req = request(app).post('/api/admin/pdf-themes/fonts').set(auth);
  const all = { name: `Brand ${Math.random().toString(36).slice(2, 8)}`, licenceNote: 'OFL 1.1, bought with the brand kit', licenceAcknowledged: 'true', ...fields };
  for (const [key, value] of Object.entries(all)) if (value !== undefined) req = req.field(key, value);
  for (const [key, buffer] of Object.entries(files)) req = req.attach(key, buffer, { filename: `${key}.ttf`, contentType: 'font/ttf' });
  return req;
}

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
  app = buildRouteApp('/api/admin/pdf-themes', require('../../src/routes/adminPdfThemes'));
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a valid TTF family is stored by content under business-docs/fonts and offered to themes', async () => {
  const res = await upload({ regular, bold, italic }, { name: 'Brand Sans' });
  expect(res.status).toBe(201);
  const { font } = res.body;
  expect(font).toEqual(expect.objectContaining({ family: `upload-${font.id}`, name: 'Brand Sans', isActive: true }));
  expect(font.files.map((f) => f.style).sort()).toEqual(['400', '400i', '700']);
  expect(font.licenceAcknowledgedAt).toBeTruthy();
  for (const buffer of [regular, bold, italic]) {
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'business-docs', 'fonts', `${sha256(buffer)}.ttf`))).toBe(true);
  }
  const list = await request(app).get('/api/admin/pdf-themes').set(auth);
  expect(list.body.uploadedFonts).toEqual(expect.arrayContaining([{ family: font.family, name: 'Brand Sans' }]));
  // A theme may now pick it.
  const saved = await request(app).put('/api/admin/pdf-themes/quote').set(auth).send({ settings: { fontFamily: font.family } });
  expect(saved.status).toBe(200);
  await request(app).put('/api/admin/pdf-themes/quote').set(auth).send({ settings: {} });
});

test.each([
  ['a WOFF2 file named .ttf', () => fs.readFileSync(path.join(FONTS, '400.woff2')), 'FONT_FORMAT_UNSUPPORTED'],
  ['a truncated file', () => regular.subarray(0, 4000), 'FONT_MALFORMED'],
  ['a font whose licence restricts embedding', () => restricted(regular), 'FONT_LICENCE_RESTRICTED'],
  ['a font that may not be subset', () => restricted(regular, 0x0100), 'FONT_NO_SUBSETTING'],
  ['a font that may only be embedded as bitmaps', () => restricted(regular, 0x0200), 'FONT_BITMAP_ONLY'],
  ['something that is not a font', () => Buffer.from('%PDF-1.7 not a font at all, really'), 'FONT_NOT_A_FONT'],
  ['a file over 5 MB', () => Buffer.concat([regular, Buffer.alloc(5 * 1024 * 1024)]), 'FONT_TOO_LARGE'],
])('%s is refused', async (_, make, code) => {
  const before = Number((await db('pdf_fonts').count({ n: '*' }).first()).n);
  const res = await upload({ regular: make() });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe(code);
  expect(Number((await db('pdf_fonts').count({ n: '*' }).first()).n)).toBe(before);
});

test('the licence note and the confirmation are required', async () => {
  expect((await upload({ regular }, { licenceNote: '' })).status).toBe(400);
  expect((await upload({ regular }, { licenceAcknowledged: 'false' })).status).toBe(400);
  expect((await upload({ regular }, { licenceAcknowledged: undefined })).status).toBe(400);
});

test('uploading needs settings.banking', async () => {
  const bcrypt = require('bcrypt');
  const inserted = await db('admin_users').insert({
    username: 'viewer1', email: 'viewer1@example.com', password_hash: await bcrypt.hash('x', 4),
    must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id');
  const res = await request(app).post('/api/admin/pdf-themes/fonts')
    .set('Authorization', `Bearer ${mintAdminToken(inserted[0]?.id ?? inserted[0])}`)
    .field('name', 'X').field('licenceNote', 'y').field('licenceAcknowledged', 'true')
    .attach('regular', regular, { filename: 'r.ttf' });
  expect(res.status).toBe(403);
});

test('a document rendered with an uploaded font is byte-stable, and an archived font falls back and is reported', async () => {
  const { font } = (await upload({ regular, bold }, { name: 'Stable Sans' })).body;
  await request(app).put('/api/admin/pdf-themes/default').set(auth).send({ settings: { fontFamily: font.family } });
  const pdfThemeService = require('../../src/services/pdfThemeService');
  const pdfService = require('../../src/services/pdfService');
  const theme = await pdfThemeService.resolveTheme('contract');
  expect(theme.fontFiles.body).toContain(path.join('business-docs', 'fonts', `${sha256(regular)}.ttf`));
  const context = (t) => ({
    locale: 'de', issuer: { companyName: 'Studio' }, recipient: { companyName: 'Kunde AG' }, theme: t,
    doc: { contractNumber: 'C-1', issueDate: '2026-09-14' }, sections: [{ section: 'scope', blocks: [{ name: 'A', body: 'Text' }] }],
    generatedAt: '2026-09-14T10:00:00Z',
  });
  const a = await pdfService.renderContractToBuffer(context(theme));
  const b = await pdfService.renderContractToBuffer(context(theme));
  expect(sha256(a)).toBe(sha256(b));
  const helvetica = await pdfService.renderContractToBuffer(context(require('../../src/services/pdf/theme').builtInTheme('contract')));
  expect(sha256(a)).not.toBe(sha256(helvetica));

  // The record of a generated document names the font files by hash.
  const { _internal } = require('../../src/services/documentArtifactService');
  const recorded = JSON.parse(_internal.themeSnapshot(theme, {}));
  expect(recorded.fontSha256.body).toBe(sha256(regular));
  // By id and hash, never by this server's file path.
  expect(recorded.uploadedFontId).toBe(font.id);
  expect(recorded.fontFiles).toBeUndefined();
  expect(JSON.stringify(recorded)).not.toContain(process.env.STORAGE_PATH);

  // Archived: the theme still names it, the render falls back, the check says so.
  const archived = await request(app).post(`/api/admin/pdf-themes/fonts/${font.id}/archive`).set(auth);
  expect(archived.body.font.isActive).toBe(false);
  expect((await pdfThemeService.resolveTheme('contract')).fontFiles).toBeUndefined();
  const created = await request(templatesApp).post('/api/admin/contract-templates').set(auth).send({ name: 'Font check' });
  await request(templatesApp).put(`/api/admin/contract-templates/${created.body.template.id}/draft`).set(auth).send({
    lockVersion: created.body.template.lockVersion, items: [{ kind: 'text', section: 'closing', heading: 'X', body: { de: 'x', en: 'x' } }],
  });
  const check = await request(templatesApp).post(`/api/admin/contract-templates/${created.body.template.id}/publish-check`).set(auth);
  expect(check.body.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'FONT_MISSING', severity: 'warning', key: font.family }),
  ]));
  // An archived font can't be picked again…
  expect((await request(app).put('/api/admin/pdf-themes/quote').set(auth).send({ settings: { fontFamily: font.family } })).status).toBe(400);
  // …but the theme that already names it still saves and previews an unrelated change.
  const kept = { fontFamily: font.family, colors: { accent: '#224466' } };
  expect((await request(app).put('/api/admin/pdf-themes/default').set(auth).send({ settings: kept })).status).toBe(200);
  expect((await request(app).post('/api/admin/pdf-themes/default/preview').set(auth).send({ settings: kept })).status).toBe(200);
  await request(app).put('/api/admin/pdf-themes/default').set(auth).send({ settings: {} });
});

test('the retired free-text font path moves into an uploaded font once, and the themes use it', async () => {
  const legacyDir = path.join(process.env.STORAGE_PATH, 'fonts');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'brand.ttf'), italic);
  await db('business_profile').where({ id: 1 }).update({ pdf_font_ttf_path: 'fonts/brand.ttf' });
  await request(app).put('/api/admin/pdf-themes/invoice').set(auth).send({ settings: { titleSize: 22 } });

  const { migrateLegacyFont } = require('../../src/services/pdf/uploadedFonts');
  const logger = { info: jest.fn(), warn: jest.fn() };
  const moved = await migrateLegacyFont(logger);
  expect(moved).toEqual(expect.objectContaining({ family: expect.stringMatching(/^upload-\d+$/) }));
  expect((await db('business_profile').where({ id: 1 }).first()).pdf_font_ttf_path).toBeNull();
  const row = await db('pdf_fonts').where({ id: moved.id }).first();
  expect(row.licence_acknowledged_at).toBeNull();
  const themes = Object.fromEntries((await db('pdf_themes').select('scope', 'settings'))
    .map((r) => [r.scope, typeof r.settings === 'string' ? JSON.parse(r.settings) : r.settings]));
  expect(themes.default.fontFamily).toBe(moved.family);
  expect(themes.invoice).toEqual({ titleSize: 22, fontFamily: moved.family });
  // Once: nothing left to move.
  expect(await migrateLegacyFont(logger)).toBeNull();
  expect(Number((await db('pdf_fonts').where({ display_name: row.display_name }).count({ n: '*' }).first()).n)).toBe(1);
});

test('an earlier font that cannot be moved is recorded, the column cleared, and the fonts list says why', async () => {
  const { migrateLegacyFont } = require('../../src/services/pdf/uploadedFonts');
  const logger = { info: jest.fn(), warn: jest.fn() };
  const legacyDir = path.join(process.env.STORAGE_PATH, 'fonts');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'locked.ttf'), restricted(regular));
  await db('business_profile').where({ id: 1 }).update({ pdf_font_ttf_path: 'fonts/locked.ttf' });

  expect(await migrateLegacyFont(logger)).toBeNull();
  expect((await db('business_profile').where({ id: 1 }).first()).pdf_font_ttf_path).toBeNull();
  const list = await request(app).get('/api/admin/pdf-themes/fonts').set(auth);
  expect(list.body.legacyMoveFailure).toEqual(expect.objectContaining({ reason: 'FONT_LICENCE_RESTRICTED', path: 'fonts/locked.ttf' }));
  // Nothing left to retry at the next boot, so no warning there.
  logger.warn.mockClear();
  expect(await migrateLegacyFont(logger)).toBeNull();
  expect(logger.warn).not.toHaveBeenCalled();

  // A missing file and an oversized one are recorded the same way, without reading it.
  await db('business_profile').where({ id: 1 }).update({ pdf_font_ttf_path: 'fonts/gone.ttf' });
  await migrateLegacyFont(logger);
  expect((await request(app).get('/api/admin/pdf-themes/fonts').set(auth)).body.legacyMoveFailure.reason).toBe('FONT_FILE_NOT_FOUND');
  fs.writeFileSync(path.join(legacyDir, 'huge.ttf'), Buffer.alloc(6 * 1024 * 1024));
  await db('business_profile').where({ id: 1 }).update({ pdf_font_ttf_path: 'fonts/huge.ttf' });
  const read = jest.spyOn(fs, 'readFileSync');
  await migrateLegacyFont(logger);
  expect(read.mock.calls.some(([f]) => String(f).endsWith('huge.ttf'))).toBe(false);
  read.mockRestore();
  expect((await request(app).get('/api/admin/pdf-themes/fonts').set(auth)).body.legacyMoveFailure.reason).toBe('FONT_TOO_LARGE');
});
