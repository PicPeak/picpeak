/**
 * Publishing must not be a way around the configured gallery password policy.
 *
 * `POST /:id/publish` (#627) re-hashes `password_hash` from a plaintext the
 * admin re-types in the publish dialog, and validated it with nothing but
 * express-validator's `isLength({ min: 6 })`. So the configured complexity —
 * moderate by default, meaning 8 characters plus upper, lower and a digit —
 * governed event creation and password reset, while this door accepted
 * `aaaaaa` and made it the live gallery password.
 *
 * Not an escalation: it needs admin auth plus events.edit, and such an admin
 * could already set a weak password elsewhere. It is a policy gap — the admin
 * UI advertises a complexity level this write path did not enforce.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubpolicy-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'publish-policy-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubpolicy-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

describe('publish enforces the gallery password policy', () => {
  let db; let cleanup; let app; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'admin');
    token = mintAdminToken(adminId);
    app = buildRouteApp('/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function seedDraft(slug) {
    const [row] = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Event ${slug}`,
      event_date: '2026-09-01',
      host_email: 'client@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'original-hash',
      require_password: 1,
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-token`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  it('refuses a password that misses the configured complexity', async () => {
    const id = await seedDraft('weak-publish');

    const res = await request(app)
      .post(`/admin/events/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'aaaaaa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/security requirements/i);

    // Rejected BEFORE the write, not after — the gallery must be untouched,
    // and still a draft.
    const after = await db('events').where({ id }).first();
    expect(after.password_hash).toBe('original-hash');
    expect(after.is_draft === 1 || after.is_draft === true).toBe(true);
  });

  it('still accepts a password that meets it', async () => {
    const id = await seedDraft('strong-publish');

    const res = await request(app)
      .post(`/admin/events/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'Sup3r-Secret' });

    expect(res.status).toBe(200);

    const bcrypt = require('bcrypt');
    const after = await db('events').where({ id }).first();
    expect(after.password_hash).not.toBe('original-hash');
    expect(await bcrypt.compare('Sup3r-Secret', after.password_hash)).toBe(true);
  });

  it('leaves a publish without a password alone', async () => {
    // The legacy sentinel path: no password in the body means no rehash, so
    // the policy has nothing to check and must not block the publish.
    const id = await seedDraft('no-password-publish');

    const res = await request(app)
      .post(`/admin/events/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    const after = await db('events').where({ id }).first();
    expect(after.password_hash).toBe('original-hash');
  });
});
