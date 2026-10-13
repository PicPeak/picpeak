/**
 * PostgreSQL checks for the "mail me when the download is ready" requests
 * (issue 1733). Gated: runs only when PICPEAK_PG_TEST_URL points at a
 * throwaway database (CI sets it), e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:picpeak_secure_pass_2024@127.0.0.1:7102/picpeak_test_x" \
 *     npx jest __tests__/integration/downloadJobNotifierPg.test.js
 *
 * What SQLite cannot answer, because it has one connection and serialises
 * every transaction:
 *   - the hourly cap under requests that really run at once (advisory lock);
 *   - the lock order against gallery deletion, which takes the event row and
 *     then cascades down to the request rows.
 *
 * The suite works in a schema of its own with just the tables the notifier
 * touches, and stubs what the notify pass reads around them (deliverability,
 * the gallery link). The queue insert is real: its foreign key to the event
 * is one half of the lock order under test.
 */

const knex = require('knex');
const crypto = require('crypto');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

maybe('download job notifier on Postgres', () => {
  let owner;
  let pgDb;
  let schema;
  let notifier;
  let previousClient;
  let counter = 0;

  beforeAll(async () => {
    schema = `dl_notifier_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: PG_URL });
    await owner.schema.createSchema(schema);
    pgDb = knex({ client: 'pg', connection: PG_URL, searchPath: [schema], pool: { min: 0, max: 12 } });

    await pgDb.schema.createTable('events', (t) => {
      t.increments('id'); t.string('slug'); t.string('event_name');
    });
    await pgDb.schema.createTable('download_jobs', (t) => {
      t.increments('id');
      t.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      t.string('token'); t.string('status'); t.string('visibility_scope'); t.timestamp('expires_at');
    });
    await pgDb.schema.createTable('gallery_guests', (t) => {
      t.increments('id');
      t.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      t.string('email'); t.boolean('is_deleted').defaultTo(false); t.timestamp('email_verified_at');
    });
    await pgDb.schema.createTable('customer_accounts', (t) => {
      t.increments('id'); t.string('email'); t.boolean('is_active').defaultTo(true);
    });
    // As db.js creates it: a foreign key to the event, without a cascade.
    await pgDb.schema.createTable('email_queue', (t) => {
      t.increments('id');
      t.integer('event_id').references('id').inTable('events');
      t.string('recipient_email').notNullable(); t.string('email_type').notNullable();
      t.json('email_data'); t.string('status').defaultTo('pending');
    });
    const migration = require('../../migrations/core/293_download_job_recipients');
    await migration.up(pgDb);
    await migration.up(pgDb);

    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    jest.resetModules();
    jest.doMock('../../src/database/db', () => ({ db: pgDb }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    jest.doMock('../../src/services/downloadJobService', () => ({ isDeliverableToAnyone: async () => true }));
    jest.doMock('../../src/services/galleryNotificationService', () => ({
      galleryLinkFor: async (event, email, shareUrl) => shareUrl,
    }));
    jest.doMock('../../src/services/shareLinkService', () => ({
      getEventShareToken: () => null, buildShareLinkVariants: async () => ({}),
    }));
    jest.doMock('../../src/utils/frontendUrl', () => ({ getAbsoluteFrontendUrl: async () => 'https://example.test' }));
    jest.doMock('../../src/services/emailProcessor', () => ({
      queueEmail: async (eventId, to, type, data, { trx }) => {
        await trx('email_queue').insert({
          event_id: eventId, recipient_email: to, email_type: type, email_data: JSON.stringify(data),
        });
        return true;
      },
    }));
    notifier = require('../../src/services/downloadJobNotifier');
  }, 60000);

  afterAll(async () => {
    for (const mod of ['database/db', 'utils/logger', 'services/downloadJobService',
      'services/galleryNotificationService', 'services/shareLinkService', 'utils/frontendUrl',
      'services/emailProcessor']) jest.dontMock(`../../src/${mod}`);
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previousClient;
    if (pgDb) await pgDb.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
  });

  const first = (rows) => rows[0].id;

  async function makeEvent() {
    counter += 1;
    const id = first(await pgDb('events').insert({ slug: `pg-${counter}`, event_name: 'PG' }).returning('id'));
    return pgDb('events').where({ id }).first();
  }

  async function makeJob(event, status = 'building') {
    counter += 1;
    const id = first(await pgDb('download_jobs').insert({
      event_id: event.id,
      token: String(counter).padStart(64, 'e'),
      status,
      visibility_scope: 'public',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }).returning('id'));
    return pgDb('download_jobs').where({ id }).first();
  }

  async function makeGuest(event, email) {
    const id = first(await pgDb('gallery_guests').insert({
      event_id: event.id, email, email_verified_at: new Date().toISOString(),
    }).returning('id'));
    return { email, guestId: id };
  }

  test('the hourly cap holds when the requests run at once on real connections', async () => {
    const event = await makeEvent();
    const guest = await makeGuest(event, 'burst@example.com');
    const jobs = [];
    for (let i = 0; i < notifier.MAX_REQUESTS_PER_HOUR + 5; i += 1) jobs.push(await makeJob(event));

    const outcomes = await Promise.all(jobs.map((job) => notifier.request(job, guest)));
    expect(outcomes.filter((o) => o === 'requested')).toHaveLength(notifier.MAX_REQUESTS_PER_HOUR);
    expect(outcomes.filter((o) => o === 'limit')).toHaveLength(5);
    expect(await pgDb('download_job_recipients').where({ email: guest.email }))
      .toHaveLength(notifier.MAX_REQUESTS_PER_HOUR);
  });

  test('the same request arriving twice at once leaves one row and no error', async () => {
    const event = await makeEvent();
    const guest = await makeGuest(event, 'twice@example.com');
    const job = await makeJob(event);
    expect(await Promise.all([notifier.request(job, guest), notifier.request(job, guest)]))
      .toEqual(['requested', 'requested']);
    expect(await pgDb('download_job_recipients').where({ job_id: job.id })).toHaveLength(1);
  });

  test('two notify passes at once queue one mail', async () => {
    const event = await makeEvent();
    const guest = await makeGuest(event, 'once@example.com');
    const job = await makeJob(event);
    await notifier.request(job, guest);
    await pgDb('download_jobs').where({ id: job.id }).update({ status: 'ready' });
    const sent = await Promise.all([notifier.notifyReady(job.id), notifier.notifyReady(job.id)]);
    expect(sent[0] + sent[1]).toBe(1);
    expect(await pgDb('email_queue').where({ recipient_email: guest.email })).toHaveLength(1);
  });

  test('the sweep finds a job\'s pending mail in the json column', async () => {
    const event = await makeEvent();
    const guest = await makeGuest(event, 'swept@example.com');
    const [swept, kept] = [await makeJob(event), await makeJob(event)];
    for (const job of [swept, kept]) {
      await notifier.request(job, guest);
      await pgDb('download_jobs').where({ id: job.id }).update({ status: 'ready' });
      await notifier.notifyReady(job.id);
    }
    await notifier.cancelPendingMails([swept]);
    const mails = await pgDb('email_queue').where({ recipient_email: guest.email }).orderBy('id');
    expect(mails.map((m) => m.status)).toEqual(['cancelled', 'pending']);
  });

  // Gallery deletion as deleteEventCascade orders it: the event row first,
  // then everything under it.
  test('a notify pass waits for a gallery deletion instead of deadlocking with it', async () => {
    const event = await makeEvent();
    const guest = await makeGuest(event, 'deleted@example.com');
    const job = await makeJob(event);
    await notifier.request(job, guest);
    await pgDb('download_jobs').where({ id: job.id }).update({ status: 'ready' });

    let pass;
    await pgDb.transaction(async (trx) => {
      await trx('events').where({ id: event.id }).forUpdate().first();
      pass = notifier.notifyReady(job.id);
      // The pass is now parked on the event row. Had it claimed the request
      // row first, the cascade below would wait on that row while the pass
      // waits on the event: PostgreSQL aborts one of them (40P01).
      await new Promise((resolve) => setTimeout(resolve, 500));
      await trx.raw('SET LOCAL lock_timeout = \'5s\'');
      await trx('email_queue').where({ event_id: event.id }).del();
      await trx('events').where({ id: event.id }).del();
    });

    expect(await pass).toBe(0);
    expect(await pgDb('email_queue').where({ recipient_email: guest.email })).toHaveLength(0);
    expect(await pgDb('download_job_recipients').where({ job_id: job.id })).toHaveLength(0);
    const { warn } = require('../../src/utils/logger');
    expect(warn).not.toHaveBeenCalledWith('download_ready mail could not be queued', expect.anything());
  });

  test('a request being recorded is ordered against a gallery deletion the same way', async () => {
    const event = await makeEvent();
    const guest = await makeGuest(event, 'late@example.com');
    const job = await makeJob(event);

    let asking;
    await pgDb.transaction(async (trx) => {
      await trx('events').where({ id: event.id }).forUpdate().first();
      asking = notifier.request(job, guest);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await trx.raw('SET LOCAL lock_timeout = \'5s\'');
      await trx('events').where({ id: event.id }).del();
    });

    expect(await asking).toBe('gone');
    expect(await pgDb('download_job_recipients').where({ email: guest.email })).toHaveLength(0);
  });

  test('customer erasure and a request for that account do not leave the address behind', async () => {
    const event = await makeEvent();
    const job = await makeJob(event);
    const id = first(await pgDb('customer_accounts').insert({ email: 'erase@example.com' }).returning('id'));
    const recipient = { email: 'erase@example.com', customerId: id };

    // The erasure as eraseCustomer orders it: forget, then anonymise.
    const erasure = pgDb.transaction(async (trx) => {
      await notifier.forgetCustomer(trx, id, 'erase@example.com');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await trx('customer_accounts').where({ id }).update({ email: `deleted-${id}@deleted.invalid` });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const outcome = await notifier.request(job, recipient);
    await erasure;

    expect(outcome).toBe('gone');
    expect(await pgDb('download_job_recipients').where({ email: 'erase@example.com' })).toHaveLength(0);
  });
});
