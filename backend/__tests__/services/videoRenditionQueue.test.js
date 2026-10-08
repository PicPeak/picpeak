/**
 * videoRenditionQueue.claimNext: the same claim contract backgroundProcessor
 * and faceQueue pin — SKIP LOCKED on Postgres, a status-guarded UPDATE on
 * SQLite, ISO-string timestamps.
 */

jest.mock('../../src/services/videoRenditionService', () => ({
  isEnabled: jest.fn(),
  renderWebCopy: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/linuxKernelLease', () => ({ acquire: async () => ({ device: '1', inode: '2', filesystem: '3', release: async () => {} }) }));
jest.mock('../../src/services/linuxProcessLease', () => ({ currentIdentity: async () => ({ host: 'fixture' }) }));

function makeFakeDb({ pendingRow = null, updateResult = 1, clientName = 'pg' } = {}) {
  const queries = [];
  const builder = table => {
    const recorded = { wheres: [], updates: null, locked: false, skipped: false };
    queries.push(recorded);
    const chain = {
      where: jest.fn(function (...args) { recorded.wheres.push(args); return chain; }),
      orderBy: jest.fn(function () { return chain; }),
      forUpdate: jest.fn(function () { recorded.locked = true; return chain; }),
      skipLocked: jest.fn(function () { recorded.skipped = true; return chain; }),
      first: jest.fn(async function () { return table === 'photos' && pendingRow ? { ...pendingRow } : null; }),
      update: jest.fn(async function (data) { recorded.updates = data; return updateResult; }),
      insert: jest.fn(async () => 1),
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
    };
    return chain;
  };
  const trxFn = table => builder(table);
  trxFn.client = { config: { client: clientName } };
  trxFn.transaction = async (cb) => cb(trxFn);
  return { db: trxFn, queries };
}

function loadQueue(db) {
  jest.resetModules();
  jest.doMock('../../src/database/db', () => ({ db }));
  return require('../../src/services/videoRenditionQueue');
}

describe('videoRenditionQueue.claimNext', () => {
  it('returns null when nothing is pending', async () => {
    const { db } = makeFakeDb({ pendingRow: null });
    expect(await loadQueue(db).claimNext()).toBeNull();
  });

  it('claims with FOR UPDATE SKIP LOCKED on Postgres and flips the row to processing', async () => {
    const pendingRow = { id: 42, web_status: 'pending' };
    const { db, queries } = makeFakeDb({ pendingRow, clientName: 'pg' });
    // The claim comes back with its token: the time the worker fences on.
    expect(await loadQueue(db).claimNext()).toMatchObject({ ...pendingRow, web_status: 'processing', web_attempt_id: expect.any(String), web_started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
    expect(queries.some(query => query.locked && query.skipped)).toBe(true);
    expect(queries[0].wheres[0]).toEqual(['web_status', 'pending']);
    expect(queries.find(query => query.updates).updates.web_status).toBe('processing');
    expect(queries.find(query => query.updates).updates.web_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('on SQLite returns the row only when the guarded UPDATE wins', async () => {
    const pendingRow = { id: 7 };
    const lost = makeFakeDb({ pendingRow, clientName: 'sqlite3', updateResult: 0 });
    expect(await loadQueue(lost.db).claimNext()).toBeNull();

    const won = makeFakeDb({ pendingRow, clientName: 'sqlite3', updateResult: 1 });
    expect(await loadQueue(won.db).claimNext()).toMatchObject({ ...pendingRow, web_status: 'processing', web_attempt_id: expect.any(String), web_started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
    expect(won.queries[0].locked).toBe(false);
    const update = won.queries.find((q) => q.updates);
    expect(update.wheres[0]).toEqual([{ id: 7, web_status: 'pending' }]);
  });
});
