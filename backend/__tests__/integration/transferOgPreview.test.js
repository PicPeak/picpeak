'use strict';

/**
 * Transfer link previews against real `transfers` rows (#997).
 *
 * transferOgService's unit test mocks transferService whole, so the kind
 * filter, the real assertDownloadable / assertUploadable, the flag read and
 * the handler's headers / 400 path had no coverage. This drives the handler
 * as server.js mounts it, over HTTP, with nothing mocked.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = 'https://portal.example';

const express = require('express');
const request = require('supertest');
const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let app;
let invalidateFeatureFlagCache;

const iso = () => new Date().toISOString();
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();
let seq = 0;

// createTransfer writes expires_at as a Date, which SQLite under jest stores
// as "[object Object]" — insert rows directly with ISO strings instead.
async function makeTransfer(overrides = {}) {
  seq += 1;
  const token = `${seq}`.padStart(64, 'c');
  const kind = overrides.kind || 'send';
  await db('transfers').insert({
    token,
    kind,
    title: `Hochzeit <Anna> & Ben ${seq}`,
    message: 'private note for the recipient',
    expires_at: future(),
    is_active: true,
    grace_days: 7,
    allow_uploads: kind === 'request',
    created_at: iso(),
    updated_at: iso(),
    ...overrides,
  });
  return token;
}

async function setFlag(on) {
  const row = await db('feature_flags').where({ key: 'transfers' }).first();
  if (row) await db('feature_flags').where({ key: 'transfers' }).update({ value: on });
  else await db('feature_flags').insert({ key: 'transfers', value: on });
  invalidateFeatureFlagCache();
}

async function setSetting(key, value) {
  const encoded = JSON.stringify(value);
  const row = await db('app_settings').where({ setting_key: key }).first();
  if (row) await db('app_settings').where({ setting_key: key }).update({ setting_value: encoded });
  else await db('app_settings').insert({ setting_key: key, setting_value: encoded, setting_type: 'branding' });
}

const ogTitle = (html) => (html.match(/property="og:title" content="([^"]*)"/) || [])[1];
const ogDesc = (html) => (html.match(/property="og:description" content="([^"]*)"/) || [])[1];

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag'));
  const { handleTransferOgRequest } = require('../../src/services/transferOgService');
  await setSetting('branding_company_name', 'Studio Test');
  await setSetting('branding_company_tagline', 'Wedding & portrait photography');
  await setFlag(true);
  app = express();
  app.get('/og/transfer/:token', handleTransferOgRequest('send'));
  app.get('/og/transfer-upload/:token', handleTransferOgRequest('request'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('live transfers', () => {
  it('send: escaped title + company, tagline, no message, private headers', async () => {
    const token = await makeTransfer();
    const res = await request(app).get(`/og/transfer/${token}`);
    expect(res.status).toBe(200);
    expect(ogTitle(res.text)).toMatch(/^Hochzeit &lt;Anna&gt; &amp; Ben \d+ — Studio Test$/);
    expect(ogDesc(res.text)).toBe('Wedding &amp; portrait photography');
    expect(res.text).not.toContain('private note');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('request: resolves on the upload path', async () => {
    const token = await makeTransfer({ kind: 'request' });
    const res = await request(app).get(`/og/transfer-upload/${token}`);
    expect(ogTitle(res.text)).toMatch(/— Studio Test$/);
    expect(ogTitle(res.text)).not.toBe('Studio Test');
  });

  it('a preview does not count as a download', async () => {
    const token = await makeTransfer({ max_downloads: 1 });
    await request(app).get(`/og/transfer/${token}`);
    const row = await db('transfers').where({ token }).first();
    expect(Number(row.download_count || 0)).toBe(0);
  });
});

describe('generic card, no title', () => {
  it.each([
    ['expired', () => makeTransfer({ expires_at: past() }), 'transfer'],
    ['disabled', () => makeTransfer({ is_active: false }), 'transfer'],
    ['download cap used up', () => makeTransfer({ max_downloads: 1, download_count: 1 }), 'transfer'],
    ['soft-deleted', () => makeTransfer({ deleted_at: iso() }), 'transfer'],
    ['request with uploads off', () => makeTransfer({ kind: 'request', allow_uploads: false }), 'transfer-upload'],
    ['send token on the upload path', () => makeTransfer(), 'transfer-upload'],
    ['request token on the download path', () => makeTransfer({ kind: 'request' }), 'transfer'],
    ['unknown token', async () => 'e'.repeat(64), 'transfer'],
  ])('%s', async (_label, make, prefix) => {
    const token = await make();
    const res = await request(app).get(`/og/${prefix}/${token}`);
    expect(res.status).toBe(200);
    expect(ogTitle(res.text)).toBe('Studio Test');
  });

  it('short upload code is never resolved', async () => {
    await makeTransfer({ kind: 'request', upload_token: 'ABCD2345' });
    const res = await request(app).get('/og/transfer-upload/ABCD2345');
    expect(ogTitle(res.text)).toBe('Studio Test');
  });

  it('transfers flag off', async () => {
    const token = await makeTransfer();
    await setFlag(false);
    try {
      const res = await request(app).get(`/og/transfer/${token}`);
      expect(ogTitle(res.text)).toBe('Studio Test');
    } finally {
      await setFlag(true);
    }
  });
});

it('malformed token → 400', async () => {
  const res = await request(app).get('/og/transfer/not_a-token!');
  expect(res.status).toBe(400);
});

it('speaks the default language (issue 2489)', async () => {
  const token = await makeTransfer({ kind: 'request' });
  await setSetting('general_default_language', 'de');
  await db('app_settings').where({ setting_key: 'branding_company_tagline' }).del();
  try {
    const res = await request(app).get(`/og/transfer-upload/${token}`);
    expect(ogDesc(res.text)).toBe('Laden Sie Ihre Dateien hier hoch.');
    expect(res.text).toContain('<html lang="de">');
    expect(res.text).toContain('>Dateien hochladen</a>');
  } finally {
    await setSetting('general_default_language', 'en');
    await setSetting('branding_company_tagline', 'Wedding & portrait photography');
  }
});
