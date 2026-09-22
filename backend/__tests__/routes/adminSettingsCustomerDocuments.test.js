/**
 * The customer-document settings on PUT /api/admin/settings/general (#1444,
 * review round 1). They were stored unchecked: "constructor" counted as a
 * format (FORMATS["constructor"] is Object's constructor), and a later
 * upload named *.constructor then crashed the upload filter.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'docsettings-test-secret';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

let db; let cleanup; let app; let tok;
const put = (body) => request(app).put('/api/admin/settings/general').set('Authorization', `Bearer ${tok}`).send(body);
const stored = async (key) => {
  const row = await db('app_settings').where({ setting_key: key }).first();
  return row ? JSON.parse(row.setting_value) : undefined;
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  tok = mintAdminToken(adminId);
  require('../../src/middleware/permissions').clearPermissionCache();
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
}, 300000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('customer document settings', () => {
  it('refuses unknown formats, including inherited property names, and stores nothing', async () => {
    for (const bad of [['pdf', 'constructor'], ['__proto__'], ['exe'], [], 'pdf', ['toString']]) {
      const res = await put({ customer_documents_allowed_formats: bad });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
    expect(await stored('customer_documents_allowed_formats')).toEqual(['pdf']);
  });

  it('stores known formats in registry order', async () => {
    const res = await put({ customer_documents_allowed_formats: ['csv', 'pdf', 'docx', 'pdf'] });
    expect(res.status).toBe(200);
    expect(await stored('customer_documents_allowed_formats')).toEqual(['pdf', 'docx', 'csv']);
  });

  it.each([
    ['customer_documents_max_upload_size_mb', [0, -5, 1.5, 'abc', '', 5000], 50],
    ['customer_documents_quota_mb', [0, 'x', 2e6], 500],
    ['customer_documents_retention_days', [0, 4000, 2.5], 14],
    ['customer_documents_forbidden_alert_threshold', [0, -1, 'many'], 5],
  ])('checks %s', async (key, bad, good) => {
    for (const value of bad) {
      expect((await put({ [key]: value })).status).toBe(400);
    }
    expect((await put({ [key]: String(good) })).status).toBe(200);
    expect(await stored(key)).toBe(good);
  });

  it('checks the reminder ladder and normalises it', async () => {
    for (const bad of ['3,x', '0', '3;7', '9999', ['3'], '1,2,3,4,5,6,7,8,9,10,11']) {
      expect((await put({ customer_documents_request_reminder_days: bad })).status).toBe(400);
    }
    expect((await put({ customer_documents_request_reminder_days: ' 7, 3,3 ' })).status).toBe(200);
    expect(await stored('customer_documents_request_reminder_days')).toBe('3,7');
    expect((await put({ customer_documents_request_reminder_days: '' })).status).toBe(200);
    expect(await stored('customer_documents_request_reminder_days')).toBe('');
  });

  it('wants a boolean for notify-on-share', async () => {
    expect((await put({ customer_documents_notify_on_share: 'yes' })).status).toBe(400);
    expect((await put({ customer_documents_notify_on_share: false })).status).toBe(200);
    expect(await stored('customer_documents_notify_on_share')).toBe(false);
  });
});

describe('format lookups use own keys only', () => {
  const formats = require('../../src/services/documentFormats');

  it('never treats an inherited property name as a format', async () => {
    for (const name of ['x.constructor', 'x.toString', 'x.__proto__', 'x.hasOwnProperty']) {
      expect(formats.formatForName(name)).toBeNull();
    }
    expect(formats.isFormat('constructor')).toBe(false);
    expect(formats.contentTypeFor('constructor')).toBe('application/pdf');
    await db('app_settings').where({ setting_key: 'customer_documents_allowed_formats' })
      .update({ setting_value: JSON.stringify(['constructor', 'docx']) });
    expect(await formats.getAllowedFormats()).toEqual(['docx']);
  });
});

