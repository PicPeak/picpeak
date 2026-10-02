/**
 * The reCAPTCHA secret is masked on GET. The Security tab loads that mask
 * into its form state and sends every security_* key back on save, so the
 * PUT received the mask and upserted it as the secret. With reCAPTCHA on,
 * services/recaptcha.js then verified against eight bullets, Google refused,
 * and every captcha-gated login failed closed until someone re-typed the key
 * (security review 2026-09-29). Analytics and backup already skipped the
 * sentinel; this pins the same behaviour for Security.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-secmask-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secmask-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-secmask-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { decodeSettingValue } = require('../helpers/settingValue');

const MASK = '••••••••';
const KEY = 'security_recaptcha_secret_key';

describe('PUT /api/admin/settings/security — masked secret round-trip', () => {
  let db; let cleanup; let app; let tok;
  const auth = (req) => req.set('Authorization', `Bearer ${tok}`);
  const stored = async () => {
    const row = await db('app_settings').where({ setting_key: KEY }).first();
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    tok = mintAdminToken(adminId);
    clearPermissionCache();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('masks the stored secret on GET', async () => {
    await db('app_settings').insert({
      setting_key: KEY, setting_value: JSON.stringify('6Lc-real-secret'), setting_type: 'security',
    });
    const res = await auth(request(app).get('/api/admin/settings'));
    expect(res.status).toBe(200);
    expect(res.body[KEY]).toBe(MASK);
  });

  it('keeps the stored secret when the save carries the mask back', async () => {
    const res = await auth(request(app).put('/api/admin/settings/security'))
      .send({ security_enable_recaptcha: true, [KEY]: MASK });
    expect(res.status).toBe(200);
    expect(await stored()).toBe('6Lc-real-secret');
    // The other key in the same save still lands.
    const flag = await db('app_settings').where({ setting_key: 'security_enable_recaptcha' }).first();
    expect(decodeSettingValue(db, flag.setting_value)).toBe(true);
  });

  it('still replaces the secret when a new value is sent', async () => {
    const res = await auth(request(app).put('/api/admin/settings/security'))
      .send({ [KEY]: '6Lc-rotated' });
    expect(res.status).toBe(200);
    expect(await stored()).toBe('6Lc-rotated');
  });
});
