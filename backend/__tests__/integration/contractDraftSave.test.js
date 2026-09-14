/**
 * Saving a contract draft from the editor (issue 1447).
 *
 * createContract and updateContract checked for the contracts.project_id
 * column with hasColumnCached INSIDE their transaction. That helper reads the
 * schema through the global db, and on SQLite's single-connection pool the
 * read waits for the connection the transaction holds. The editor always
 * sends projectId, so every create stalled for the pool's 60s acquire timeout
 * and answered 500 ("An unexpected error occurred"); the edit-save did the
 * same. Postgres has more than one connection and was unaffected.
 *
 * The editor also created the draft and then sent a second request with the
 * block selection. Now the selection travels with the create and commits in
 * the same transaction, so there is no state in which a draft exists without
 * the admin's blocks.
 *
 * The requests are time-limited well below the 60s acquire timeout, so a
 * reintroduced deadlock fails here instead of passing slowly.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

const WITHIN = 15000;

describe('contract draft save (issue 1447)', () => {
  let db;
  let cleanup;
  let app;
  let token;
  let customerId;
  let library;

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const countRows = async (table) => Number((await db(table).count({ n: '*' }).first()).n);

  // What ContractEditorPage sends for a new contract.
  const editorCreatePayload = (blocks) => ({
    customerAccountId: customerId,
    language: 'de',
    title: 'Hochzeit',
    eventName: null,
    eventDate: null,
    eventTimeStart: null,
    eventTimeEnd: null,
    introText: null,
    outroText: null,
    issueDate: new Date().toISOString().slice(0, 10),
    projectId: null,
    blocks,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const seeded = await seedMinimal(db);
    customerId = seeded.customerId;
    await assignAdminRole(db, seeded.adminId);
    token = mintAdminToken(seeded.adminId);
    const flag = await db('feature_flags').where({ key: 'contracts' }).first();
    if (flag) await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
    else await db('feature_flags').insert({ key: 'contracts', value: true });
    app = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));

    const res = await auth(request(app).get('/api/admin/contracts/blocks'));
    library = res.body.blocks;
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  // hasColumnCached remembers a column for the life of the process, so once
  // any test resolved contracts.project_id outside a transaction, a check left
  // INSIDE one would answer from the cache and never touch the pool. A
  // restarted server has a cold cache, so every case starts cold.
  beforeEach(() => { require('../../src/utils/schemaCache').invalidateSchemaCache(); });

  it('creates a draft with the editor payload in one request, carrying the block selection', async () => {
    expect(library.length).toBeGreaterThan(1);
    // The admin switches the first system block off before saving.
    const [switchedOff, ...rest] = library;
    const blocks = [
      { blockId: switchedOff.id, included: false, position: switchedOff.displayOrder },
      ...rest.map((b) => ({ blockId: b.id, included: b.isSystem, position: b.displayOrder })),
    ];

    const res = await auth(request(app).post('/api/admin/contracts')).send(editorCreatePayload(blocks));

    expect(res.status).toBe(201);
    const inclusions = await db('contract_block_inclusions').where({ contract_id: res.body.contract.id });
    expect(inclusions).toHaveLength(blocks.length);
    const off = inclusions.find((inc) => inc.block_id === switchedOff.id);
    expect(Boolean(off.included)).toBe(false);
  }, WITHIN);

  it('still seeds every active system block when no selection is sent', async () => {
    const { blocks: _omitted, ...payload } = editorCreatePayload(undefined);

    const res = await auth(request(app).post('/api/admin/contracts')).send(payload);

    expect(res.status).toBe(201);
    const systemCount = library.filter((b) => b.isSystem).length;
    const inclusions = await db('contract_block_inclusions').where({ contract_id: res.body.contract.id });
    expect(inclusions).toHaveLength(systemCount);
  }, WITHIN);

  it('saves an existing draft from the editor, which also sends projectId', async () => {
    const created = await auth(request(app).post('/api/admin/contracts')).send(editorCreatePayload([]));
    expect(created.status).toBe(201);
    // The create above resolved contracts.project_id; clear it so the update
    // resolves the column itself, as the first save after a restart does.
    require('../../src/utils/schemaCache').invalidateSchemaCache();

    const res = await auth(request(app).put(`/api/admin/contracts/${created.body.contract.id}`)).send({
      title: 'Hochzeit (geändert)',
      projectId: null,
      blocks: library.map((b) => ({ blockId: b.id, included: true, position: b.displayOrder })),
    });

    expect(res.status).toBe(200);
    expect(res.body.contract.title).toBe('Hochzeit (geändert)');
  }, WITHIN);

  it('rejects an invalid block selection with a 400 and creates nothing', async () => {
    const before = await countRows('contracts');

    const res = await auth(request(app).post('/api/admin/contracts'))
      .send(editorCreatePayload([{ blockId: library[0].id, included: true, position: -1 }]));

    expect(res.status).toBe(400);
    expect(await countRows('contracts')).toBe(before);
  }, WITHIN);

  it('leaves no draft behind when the create fails after the contract row is written', async () => {
    const logger = require('../../src/utils/logger');
    const realInfo = logger.info;
    // The last step inside the transaction, after the contract row and its
    // inclusions are written.
    const spy = jest.spyOn(logger, 'info').mockImplementation((message, ...args) => {
      if (message === 'Contract created') throw new Error('simulated failure after insert');
      return realInfo.call(logger, message, ...args);
    });
    const contractsBefore = await countRows('contracts');
    const inclusionsBefore = await countRows('contract_block_inclusions');

    try {
      const res = await auth(request(app).post('/api/admin/contracts'))
        .send(editorCreatePayload(library.map((b) => ({ blockId: b.id, included: true, position: b.displayOrder }))));
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    expect(await countRows('contracts')).toBe(contractsBefore);
    expect(await countRows('contract_block_inclusions')).toBe(inclusionsBefore);
  }, WITHIN);
});
