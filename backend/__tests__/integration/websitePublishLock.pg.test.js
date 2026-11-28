/**
 * Issue 2618: publish read the draft with a plain SELECT inside its
 * transaction. On PostgreSQL another editor could save and publish a newer
 * revision while a publish sat between that read and its write, and the
 * late publish then put the older revision back over the newer one.
 *
 * Runs only with PICPEAK_PG_TEST_URL (CI sets it); SQLite serialises writers.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
(pgUrl ? describe : describe.skip)('website publish under a concurrent publish on PostgreSQL (issue 2618)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient; let service;
  const admin = { id: null };
  const doc = (heading) => ({ pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'h', type: 'hero', heading }] }] });

  beforeAll(async () => {
    schema = `website_publish_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'website-publish-test-secret-at-least-32-characters';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-website-publish-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 4 } }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());
    service = require('../../src/services/website/service');
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  // Some statement of another connection is waiting for a lock.
  const someoneWaits = async () => {
    const { rows } = await owner.raw('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted');
    return rows[0].n > 0;
  };

  it('a save and publish racing a publish never leaves the older revision published', async () => {
    const base = (await service.getEditorState(null)).draft.revision;
    const older = (await service.saveDraft(doc('Older'), base, admin)).draft.revision;
    await service.publish(older, null);

    // Publish A reads the draft at `older`, then pauses. In the pause editor
    // B saves and publishes a newer revision on its own connections; the
    // pause ends once B is done or blocked on a lock A holds.
    let other;
    const { client } = db;
    const transaction = client.transaction;
    const spy = jest.spyOn(client, 'transaction').mockImplementationOnce((work, ...rest) => transaction.call(client, (trx) => {
      let paused = false;
      const pausing = (...args) => {
        const query = trx(...args);
        const first = query.first.bind(query);
        query.first = async (...cols) => {
          const row = await first(...cols);
          if (row && row.state === 'draft' && !paused) {
            paused = true;
            let done = false;
            other = (async () => {
              const saved = await service.saveDraft(doc('Newer'), older, admin);
              await service.publish(saved.draft.revision, null);
            })().finally(() => { done = true; });
            const until = Date.now() + 5000;
            while (!done && !(await someoneWaits()) && Date.now() < until) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          return row;
        };
        return query;
      };
      pausing.client = trx.client;
      return work(pausing);
    }, ...rest));
    try {
      // A may land first (B waited for it) or be refused (B was first).
      await service.publish(older, null).catch((err) => expect(err.statusCode).toBe(409));
      await other;
    } finally {
      spy.mockRestore();
    }
    const published = await db('website_documents').where({ state: 'published' }).first();
    expect(Number(published.revision)).toBe(older + 1);
    expect(published.document).toContain('Newer');
  });
});
