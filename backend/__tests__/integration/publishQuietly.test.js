/**
 * Publish without notifying, and send the gallery email later (#1235).
 *
 * Publishing queued the gallery_created email whenever any customer email
 * existed, with no opt-out — so a photographer with no address yet had to type
 * their OWN into the required field, publish, receive the client-facing email
 * themselves, and hand the link over by DM. That is the workaround this
 * removes.
 *
 * The send-later half is the part that makes it a workflow rather than a dead
 * end: publishing quietly is only useful if the real email can go out once the
 * address arrives.
 *
 * The default must not move. Every existing caller — the v1 API, an older
 * frontend, a script — omits the flag entirely and must keep notifying.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-publish-quiet-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'publish-quiet-test-secret';

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../../src/middleware/ownership', () => ({
  requireEventOwnership: (_req, _res, next) => next(),
}));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db;
let cleanup;
let app;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  app = express();
  app.use(express.json());
  app.use('/admin/events', require('../../src/routes/adminEvents'));
}, 180000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

beforeEach(async () => {
  await db('email_queue').del();
  await db('events').del();
});

async function seedDraft({ slug, customerEmail = 'client@example.com', isDraft = true } = {}) {
  const [row] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: `Event ${slug}`,
    event_date: '2026-09-01',
    host_email: customerEmail,
    admin_email: 'admin@example.com',
    customer_email: customerEmail,
    password_hash: 'x',
    share_link: `/gallery/${slug}/share`,
    share_token: `${slug}-token`,
    require_password: 0,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: isDraft ? 1 : 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

const queuedFor = (eventId) =>
  db('email_queue').where({ event_id: eventId, email_type: 'gallery_created' });

describe('publish quietly (#1235)', () => {
  it('queues the gallery email by default — the flag being absent must not change anything', async () => {
    const id = await seedDraft({ slug: 'default-publish' });

    const res = await request(app).post(`/admin/events/${id}/publish`).send({});
    expect(res.status).toBe(200);
    expect(res.body.notified_customer).toBe(true);

    expect(await queuedFor(id)).toHaveLength(1);
    const event = await db('events').where({ id }).first();
    expect(Number(event.is_draft)).toBe(0);
  });

  it('publishes without queuing anything when notify_customer is false', async () => {
    const id = await seedDraft({ slug: 'quiet-publish' });

    const res = await request(app)
      .post(`/admin/events/${id}/publish`)
      .send({ notify_customer: false });
    expect(res.status).toBe(200);
    expect(res.body.notified_customer).toBe(false);

    // The whole point: live gallery, no email.
    expect(await queuedFor(id)).toHaveLength(0);
    const event = await db('events').where({ id }).first();
    expect(Number(event.is_draft)).toBe(0);
  });

  it('sends the gallery email later, on demand', async () => {
    const id = await seedDraft({ slug: 'send-later' });
    await request(app).post(`/admin/events/${id}/publish`).send({ notify_customer: false });
    expect(await queuedFor(id)).toHaveLength(0);

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(res.status).toBe(200);
    expect(res.body.recipient).toBe('client@example.com');

    const queued = await queuedFor(id);
    expect(queued).toHaveLength(1);
    const data = JSON.parse(queued[0].email_data);
    expect(data.event_name).toBe('Event send-later');
    expect(data.gallery_link).toContain('send-later');
  });

  it('refuses to send the gallery email for a draft — the link would not work yet', async () => {
    const id = await seedDraft({ slug: 'still-draft' });

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft/i);
    expect(await queuedFor(id)).toHaveLength(0);
  });

  it('refuses to send when there is no recipient', async () => {
    const [row] = await db('events').insert({
      slug: 'no-email',
      event_type: 'wedding',
      event_name: 'No Email',
      event_date: '2026-09-01',
      host_email: '',
      admin_email: 'admin@example.com',
      customer_email: null,
      password_hash: 'x',
      share_link: '/gallery/no-email/share',
      share_token: 'no-email-token',
      require_password: 0,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = typeof row === 'object' ? row.id : row;

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no customer email/i);
  });

  it('still publishes a gallery that has no recipient at all', async () => {
    const [row] = await db('events').insert({
      slug: 'quiet-no-email',
      event_type: 'wedding',
      event_name: 'Quiet No Email',
      event_date: '2026-09-01',
      host_email: '',
      admin_email: 'admin@example.com',
      customer_email: null,
      password_hash: 'x',
      share_link: '/gallery/quiet-no-email/share',
      share_token: 'quiet-no-email-token',
      require_password: 0,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = typeof row === 'object' ? row.id : row;

    const res = await request(app)
      .post(`/admin/events/${id}/publish`)
      .send({ notify_customer: false });
    expect(res.status).toBe(200);
    const event = await db('events').where({ id }).first();
    expect(Number(event.is_draft)).toBe(0);
  });

  it('re-sending is allowed — a lost email should not need an unpublish/republish', async () => {
    const id = await seedDraft({ slug: 'resend' });
    await request(app).post(`/admin/events/${id}/publish`).send({});
    expect(await queuedFor(id)).toHaveLength(1);

    const res = await request(app).post(`/admin/events/${id}/send-gallery-email`).send({});
    expect(res.status).toBe(200);
    expect(await queuedFor(id)).toHaveLength(2);
  });
});
