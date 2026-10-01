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

function makeFakeDb({ pendingRow = null, updateResult = 1, clientName = 'pg' } = {}) {
  const queries = [];
  const builder = () => {
    const recorded = { wheres: [], updates: null, locked: false, skipped: false };
    queries.push(recorded);
    const chain = {
      where: jest.fn(function (...args) { recorded.wheres.push(args); return chain; }),
      orderBy: jest.fn(function () { return chain; }),
      forUpdate: jest.fn(function () { recorded.locked = true; return chain; }),
      skipLocked: jest.fn(function () { recorded.skipped = true; return chain; }),
      first: jest.fn(async function () { return pendingRow ? { ...pendingRow } : null; }),
      update: jest.fn(async function (data) { recorded.updates = data; return updateResult; }),
    };
    return chain;
  };
  const trxFn = (table) => builder(table);
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
    expect(await loadQueue(db).claimNext()).toEqual(pendingRow);
    expect(queries[0].locked).toBe(true);
    expect(queries[0].skipped).toBe(true);
    expect(queries[0].wheres[0]).toEqual(['web_status', 'pending']);
    expect(queries[1].updates.web_status).toBe('processing');
    expect(queries[1].updates.web_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('on SQLite returns the row only when the guarded UPDATE wins', async () => {
    const pendingRow = { id: 7 };
    const lost = makeFakeDb({ pendingRow, clientName: 'sqlite3', updateResult: 0 });
    expect(await loadQueue(lost.db).claimNext()).toBeNull();

    const won = makeFakeDb({ pendingRow, clientName: 'sqlite3', updateResult: 1 });
    expect(await loadQueue(won.db).claimNext()).toEqual(pendingRow);
    expect(won.queries[0].locked).toBe(false);
    const update = won.queries.find((q) => q.updates);
    expect(update.wheres[0]).toEqual([{ id: 7, web_status: 'pending' }]);
  });
});
