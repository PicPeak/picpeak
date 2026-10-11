const knex = require('knex');
const { createWorkRegistry } = require('../../src/services/activeApplicationWork');
const { installApplicationWork } = require('../../src/database/applicationWork');

describe('database maintenance work ownership', () => {
  let database;
  let work;
  let dispose;

  beforeEach(async () => {
    database = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.schema.createTable('owned_work', table => { table.integer('id').primary(); });
    work = createWorkRegistry();
    dispose = installApplicationWork(database.client, work);
  });

  afterEach(async () => {
    dispose();
    await database.destroy();
  });

  it('refuses an originless builder, raw write and transaction before the SQL sink after closure', async () => {
    work.closeAdmission();
    await expect(database('owned_work').insert({ id: 1 })).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await expect(database.raw('INSERT INTO owned_work (id) VALUES (?)', [2])).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await expect(database.transaction(async trx => { await trx('owned_work').insert({ id: 3 }); }))
      .rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    expect(await work.runControl(() => database('owned_work'))).toEqual([]);
  });

  it('drains and permits the remainder of an already accepted transaction including its transaction client', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let reached;
    const started = new Promise(resolve => { reached = resolve; });
    const pending = work.track('accepted handler', () => database.transaction(async trx => {
      await trx('owned_work').insert({ id: 4 });
      reached();
      await gate;
      await trx.raw('INSERT INTO owned_work (id) VALUES (?)', [5]);
    }));
    await started;
    work.closeAdmission();
    let drained = false;
    const drain = work.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([pending, drain]);
    expect(await work.runControl(() => database('owned_work').orderBy('id'))).toEqual([{ id: 4 }, { id: 5 }]);
    expect(work.pendingCount()).toBe(0);
  });

  it('owns the final detached query after its handler has already returned', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const query = database('owned_work').insert({ id: 6 });
    const original = database.client._query;
    database.client._query = async function (...args) { await gate; return original.apply(this, args); };
    const running = work.track('request', () => { query.then(() => {}); });
    await running;
    work.closeAdmission();
    expect(work.pendingCount()).toBeGreaterThan(0);
    let drained = false;
    const drain = work.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    database.client._query = original;
    expect(await work.runControl(() => database('owned_work'))).toEqual([{ id: 6 }]);
  });
});
