/**
 * Unit tests for backgroundProcessor.claimNextPhoto.
 *
 * Mocks the db so we don't need a live postgres/sqlite — focuses on
 * the claim contract: returns null when no rows, returns row + flips
 * status to 'processing' when one is available, returns null when a
 * race loses the UPDATE-with-guard.
 */

jest.mock('../../src/services/photoProcessor', () => ({
  processPhoto: jest.fn(),
  processUploadedPhotos: jest.fn(),
  queueFilesForProcessing: jest.fn(),
}));

// Build a fake knex instance whose .transaction() takes a callback we can
// drive from the test, and whose query-builder records calls.
function makeFakeDb({ pendingRow = null, updateResult = 1, clientName = 'pg' } = {}) {
  const queries = [];

  const builder = () => {
    const recorded = { wheres: [], updates: null, ordered: false, locked: false, skipped: false };
    queries.push(recorded);
    const chain = {
      where: jest.fn(function (...args) {
        recorded.wheres.push(args);
        return chain;
      }),
      orderBy: jest.fn(function () {
        recorded.ordered = true;
        return chain;
      }),
      forUpdate: jest.fn(function () {
        recorded.locked = true;
        return chain;
      }),
      skipLocked: jest.fn(function () {
        recorded.skipped = true;
        return chain;
      }),
      first: jest.fn(async function () {
        // Only the SELECT chain returns the pending row; the UPDATE chain
        // never calls .first().
        return pendingRow ? { ...pendingRow } : null;
      }),
      update: jest.fn(async function (data) {
        recorded.updates = data;
        return updateResult;
      }),
    };
    return chain;
  };

  const trxFn = (table) => builder(table);
  trxFn.client = { config: { client: clientName } };
  trxFn.transaction = async (cb) => cb(trxFn);

  // Top-level db('photos') returns same builder for the janitor test path.
  const db = trxFn;
  return { db, queries };
}

describe('backgroundProcessor.claimNextPhoto', () => {
  function loadProcessor(db) {
    jest.resetModules();
    jest.doMock('../../src/database/db', () => ({ db }));
    return require('../../src/services/backgroundProcessor');
  }

  it('returns null when there are no pending photos (postgres path)', async () => {
    const { db } = makeFakeDb({ pendingRow: null, clientName: 'pg' });
    const bg = loadProcessor(db);
    const result = await bg.claimNextPhoto();
    expect(result).toBeNull();
  });

  it('returns the claimed row and flips status (postgres path)', async () => {
    const pendingRow = { id: 42, processing_status: 'pending' };
    const { db, queries } = makeFakeDb({ pendingRow, clientName: 'pg' });
    const bg = loadProcessor(db);
    const result = await bg.claimNextPhoto();
    expect(result).toEqual(pendingRow);
    // The first query is the SELECT FOR UPDATE SKIP LOCKED.
    expect(queries[0].locked).toBe(true);
    expect(queries[0].skipped).toBe(true);
    // The second query is the status update.
    expect(queries[1].updates.processing_status).toBe('processing');
    expect(queries[1].updates.processing_started_at).toBeInstanceOf(Date);
  });

  it('returns null when the SQLite UPDATE-with-guard loses the race', async () => {
    const pendingRow = { id: 7 };
    const { db } = makeFakeDb({ pendingRow, clientName: 'better-sqlite3', updateResult: 0 });
    const bg = loadProcessor(db);
    const result = await bg.claimNextPhoto();
    expect(result).toBeNull();
  });

  it('returns the row when SQLite UPDATE-with-guard wins', async () => {
    const pendingRow = { id: 7 };
    const { db, queries } = makeFakeDb({ pendingRow, clientName: 'better-sqlite3', updateResult: 1 });
    const bg = loadProcessor(db);
    const result = await bg.claimNextPhoto();
    expect(result).toEqual(pendingRow);
    // SQLite path: no FOR UPDATE / SKIP LOCKED.
    expect(queries[0].locked).toBe(false);
    expect(queries[0].skipped).toBe(false);
  });
});
