/**
 * Logo diagnostic must not leak the filesystem layout, and must mirror what
 * resolveLogoFile actually tries (GHSA-29vm, codex round 2).
 *
 * Round 1 relativised `resolvedTo` and the candidate paths but still echoed
 * `sources[].value` verbatim — and branding_logo_path is stored ABSOLUTE by
 * multer, so the layout went out anyway. It also dropped the raw-absolute
 * candidate, which the resolver retains (subject to containment), making the
 * diagnostic report every candidate as missing for a legitimately contained
 * absolute logo while `resolvedTo` named the file.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-logodiag-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'logodiag-test-secret';


const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('logo diagnostic disclosure (GHSA-29vm)', () => {
  let db; let cleanup; let app; let token;
  // bootCrmDb() sets STORAGE_PATH itself, so resolve these AFTER it runs.
  let STORAGE; let logoDir; let logoPath;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    // A legitimately contained absolute logo in a NON-standard storage subdir.
    STORAGE = process.env.STORAGE_PATH;
    logoDir = path.join(STORAGE, 'custom');
    logoPath = path.join(logoDir, 'logo.png');
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(logoPath, 'png');

    const setting = { setting_key: 'branding_logo_path', setting_value: JSON.stringify(logoPath), setting_type: 'branding' };
    const existing = await db('app_settings').where({ setting_key: 'branding_logo_path' }).first();
    if (existing) await db('app_settings').where({ setting_key: 'branding_logo_path' }).update(setting);
    else await db('app_settings').insert(setting);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const r = await db('admin_users').insert({
      username: 'diag-admin', email: 'diag@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id, is_active: 1,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    const id = r[0]?.id ?? r[0];
    token = jwt.sign(
      { id, username: 'diag-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = express();
    app.use(express.json());
    app.use('/api/admin/business-profile', require('../../src/routes/adminBusinessProfile'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('does not leak absolute paths, cwd or storage root anywhere in the payload', async () => {
    const res = await request(app)
      .get('/api/admin/business-profile/logo-diagnostic')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(STORAGE);
    expect(body).not.toContain(process.cwd());
    expect(res.body.storageRoot).toBeUndefined();
    expect(res.body.cwd).toBeUndefined();
  });

  it('still finds a contained absolute logo outside the standard subdirs', async () => {
    const res = await request(app)
      .get('/api/admin/business-profile/logo-diagnostic')
      .set('Authorization', `Bearer ${token}`);

    const source = res.body.sources.find((s) => s.label === 'app_settings.branding_logo_path');
    expect(source).toBeTruthy();
    // The resolver keeps the contained absolute candidate, so the diagnostic
    // must show it existing rather than reporting everything missing.
    expect(source.candidates.some((c) => c.exists)).toBe(true);
    expect(res.body.resolvedTo).toMatch(/^<STORAGE>\//);
  });

  it('shows the <STORAGE>/<value> candidate for a ROOT-RELATIVE logo URL (round 3)', async () => {
    // `/custom/logo.png` is a URL, not a disk path, but path.isAbsolute() says
    // true for both. Gating the stripped joins on isAbsolute() therefore hid
    // `<STORAGE>/custom/logo.png` — a candidate resolveLogoFile does try and
    // can resolve — so the diagnostic claimed nothing existed for a logo that
    // renders fine, and collapsed the configured value to its basename.
    await db('app_settings').where({ setting_key: 'branding_logo_path' })
      .update({ setting_value: JSON.stringify('/custom/logo.png') });

    const res = await request(app)
      .get('/api/admin/business-profile/logo-diagnostic')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const source = res.body.sources.find((s) => s.label === 'app_settings.branding_logo_path');
    expect(source.candidates.some((c) => c.path === '<STORAGE>/custom/logo.png' && c.exists)).toBe(true);

    // …and the disclosure guarantee still holds for this shape.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(STORAGE);
    expect(body).not.toContain(process.cwd());

    await db('app_settings').where({ setting_key: 'branding_logo_path' })
      .update({ setting_value: JSON.stringify(logoPath) });
  });
});
