/**
 * Archived contract and quote emails must not hand admins the customer's
 * link token.
 *
 * The contract_sent and quote_sent emails link to `/contract/<token>` and
 * `/quote/<token>`, and email_queue keeps the rendered body. The Messages
 * reading pane (email.view) and the project cockpit preview (events.view)
 * served that body verbatim, so an admin without any contract or quote
 * permission could copy a working link to the customer's document.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-doclinks-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doclinks-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-doclinks-storage-'));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
const { MASK, redactDocumentLinks } = require('../../src/utils/emailSecretRedaction');

const CONTRACT_TOKEN = 'a1'.repeat(32);
const QUOTE_TOKEN = 'f0'.repeat(32);
const BODY = `<p>Please sign: <a href="https://photos.example.com/contract/${CONTRACT_TOKEN}">open</a></p>`
  + `<p><a href="https://photos.example.com/quote/${QUOTE_TOKEN}?action=accept">Accept</a></p>`
  + `<p>Plain: https://photos.example.com/quote/${QUOTE_TOKEN}</p>`;

describe('redactDocumentLinks', () => {
  it('masks the token segment of contract and quote links, keeps the rest of the body', () => {
    const out = redactDocumentLinks(BODY);

    expect(out).not.toContain(CONTRACT_TOKEN);
    expect(out).not.toContain(QUOTE_TOKEN);
    expect(out).toContain(`/contract/${MASK}`);
    expect(out).toContain(`/quote/${MASK}?action=accept`);
    expect(out).toContain('Please sign:');
  });

  it('leaves values that are not a document token alone', () => {
    const other = `<p>/gallery/${'a'.repeat(64)} /contract/abc123 sha ${'d'.repeat(64)}</p>`;
    expect(redactDocumentLinks(other)).toBe(other);
    expect(redactDocumentLinks(null)).toBeNull();
    expect(redactDocumentLinks('')).toBe('');
  });
});

describe('admin email views', () => {
  let db; let cleanup; let app; let token; let rowId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    await db('feature_flags').insert({ key: 'messaging', value: true }).onConflict('key').merge({ value: true });
    invalidateFeatureFlagCache();
    const ins = await db('email_queue').insert({
      recipient_email: 'client@example.com', email_type: 'contract_sent', status: 'sent',
      created_at: new Date().toISOString(), sent_at: new Date().toISOString(), retry_count: 0,
      email_data: JSON.stringify({ contract_number: 'C-2026-0001', response_url: `https://photos.example.com/contract/${CONTRACT_TOKEN}` }),
      rendered_html: BODY,
    }).returning('id');
    rowId = ins[0]?.id ?? ins[0];
    app = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('the Messages reading pane masks document link tokens', async () => {
    const res = await request(app).get(`/api/admin/email/queue/${rowId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CONTRACT_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(QUOTE_TOKEN);
    expect(res.body.renderedHtml).toContain(`/contract/${MASK}`);
  });

  it('the project cockpit preview masks document link tokens', async () => {
    const projectService = require('../../src/services/projectService');

    const preview = await projectService.getEmailPreview(rowId);

    expect(preview.html).not.toContain(CONTRACT_TOKEN);
    expect(preview.html).not.toContain(QUOTE_TOKEN);
    expect(preview.html).toContain(`/quote/${MASK}?action=accept`);
  });
});
