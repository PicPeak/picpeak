/**
 * PostgreSQL checks for the shared maintenance-job state (#1181).
 * Gated: runs only when PICPEAK_PG_TEST_URL points at a throwaway database, e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:picpeak_secure_pass_2024@127.0.0.1:7102/picpeak_mjs_test" \
 *     npx jest __tests__/integration/maintenanceJobStatePg.test.js
 *
 * What SQLite cannot answer: the claim leans on comparing a `timestamp` column
 * against an ISO-8601 string, and on an UPDATE ... WHERE guard being atomic
 * under real concurrent connections. SQLite compares those strings
 * lexicographically and serialises writes anyway, so it would pass either way —
 * exactly the shape of divergence that has bitten this repo before.
 */

const knex = require('knex');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

maybe('maintenance job state on Postgres', () => {
  let pgDb;
  let jobs;
  const JOB = 'photo_dimension_repair';

  beforeAll(async () => {
    pgDb = knex({ client: 'pg', connection: PG_URL, pool: { min: 0, max: 10 } });
    await pgDb.raw('DROP TABLE IF EXISTS maintenance_jobs');
    await require('../../migrations/core/179_maintenance_job_state').up(pgDb);

    jest.resetModules();
    jest.doMock('../../src/database/db', () => ({ db: pgDb }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    jobs = require('../../src/services/maintenanceJobState');
  }, 60000);

  afterAll(async () => {
    jest.dontMock('../../src/database/db');
    if (pgDb) await pgDb.destroy();
  });

  beforeEach(async () => {
    await pgDb('maintenance_jobs').update({
      is_running: false, started_at: null, heartbeat_at: null, finished_at: null, last_result: null, owner: null, claim_token: null,
    });
  });

  test('the ISO-string cutoff really compares as a timestamp, not as text', async () => {
    expect(await jobs.claim(JOB)).toEqual(expect.any(String));
    expect(await jobs.claim(JOB)).toBeNull();

    await pgDb('maintenance_jobs').where({ job_name: JOB })
      .update({ heartbeat_at: new Date(Date.now() - jobs.DEFAULT_STALE_MS - 60000).toISOString() });

    // If Postgres had rejected or mis-cast the ISO string this would either
    // throw or never match.
    expect(await jobs.claim(JOB)).toEqual(expect.any(String));

    const row = await pgDb('maintenance_jobs').where({ job_name: JOB }).first();
    expect(row.heartbeat_at).toBeInstanceOf(Date);
  });

  test('concurrent claims on real connections produce exactly one winner', async () => {
    // The whole point of the conditional UPDATE. Ten connections race; nine
    // must lose. SQLite cannot demonstrate this — it serialises writers.
    const results = await Promise.all(Array.from({ length: 10 }, () => jobs.claim(JOB)));
    expect(results.filter(Boolean)).toHaveLength(1);
    // ...and the winner holds a token nobody else can forge.
    expect(results.find(Boolean)).toEqual(expect.any(String));
  });

  test('a released job can be re-claimed exactly once again', async () => {
    const token = await jobs.claim(JOB);
    await jobs.release(JOB, token, { success: 2, failed: 0 });

    const results = await Promise.all(Array.from({ length: 5 }, () => jobs.claim(JOB)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await jobs.read(JOB)).lastResult).toEqual({ success: 2, failed: 0 });
  });

  test('a superseded runner is fenced out on real Postgres', async () => {
    const oldToken = await jobs.claim(JOB);
    await pgDb('maintenance_jobs').where({ job_name: JOB })
      .update({ heartbeat_at: new Date(Date.now() - jobs.DEFAULT_STALE_MS - 60000).toISOString() });
    const newToken = await jobs.claim(JOB);

    expect(await jobs.heartbeat(JOB, oldToken)).toBe(false);
    expect(await jobs.release(JOB, oldToken, { success: 999, failed: 0 })).toBe(false);
    // The new owner still holds it, with its result unwritten.
    expect((await jobs.read(JOB)).isRunning).toBe(true);
    expect(await jobs.release(JOB, newToken, { success: 4, failed: 0 })).toBe(true);
  });

  test('read() reports a live claim as running and a stale one as not', async () => {
    await jobs.claim(JOB);
    expect((await jobs.read(JOB)).isRunning).toBe(true);

    await pgDb('maintenance_jobs').where({ job_name: JOB })
      .update({ heartbeat_at: new Date(Date.now() - jobs.DEFAULT_STALE_MS - 1000).toISOString() });
    expect((await jobs.read(JOB)).isRunning).toBe(false);
  });
});
