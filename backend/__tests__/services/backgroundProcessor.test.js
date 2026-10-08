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
jest.mock('../../src/services/linuxKernelLease', () => ({
  acquire: jest.fn(async () => ({ device: '1', inode: '2', filesystem: '3', release: jest.fn(async () => {}) })),
}));
jest.mock('../../src/services/linuxProcessLease', () => ({ currentIdentity: async () => ({ host: 'fixture' }) }));

// Build a fake knex instance whose .transaction() takes a callback we can
// drive from the test, and whose query-builder records calls.
function makeFakeDb({ pendingRow = null, updateResult = 1, clientName = 'pg' } = {}) {
  const queries = [];

  const builder = table => {
    const recorded = { wheres: [], updates: null, ordered: false, locked: false, skipped: false, deleted: false };
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
        return table === 'photos' && pendingRow ? { ...pendingRow } : null;
      }),
      update: jest.fn(async function (data) {
        recorded.updates = data;
        return updateResult;
      }),
      delete: jest.fn(async function () { recorded.deleted = true; return 1; }),
      insert: jest.fn(async () => 1),
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
    };
    return chain;
  };

  const trxFn = (table) => builder(table);
  trxFn.client = { config: { client: clientName } };
  trxFn.transaction = async (cb) => cb(trxFn);
  trxFn.fn = { now: () => 'fixture-now' };

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
    expect(result).toMatchObject({ ...pendingRow, processing_status: 'processing', processing_attempt_id: expect.any(String) });
    // The first query is the SELECT FOR UPDATE SKIP LOCKED.
    expect(queries.some(query => query.locked && query.skipped)).toBe(true);
    // The second query is the status update.
    const update = queries.find(query => query.updates);
    expect(update.updates.processing_status).toBe('processing');
    expect(update.updates.processing_attempts).toBe(1);
    // An ISO string, not a Date: on SQLite the column holds whatever the
    // driver bound, and a Date bound inside Jest lands as "[object Object]"
    // (CLAUDE.md). The janitor compares against the same shape.
    expect(update.updates.processing_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it.each(['pg', 'sqlite3'])('ends the finite automatic retry cycle on %s without starting native work', async clientName => {
    const { db, queries } = makeFakeDb({ pendingRow: { id: 7, processing_attempts: 2 }, clientName });
    const bg = loadProcessor(db);
    expect(await bg.claimNextPhoto()).toBeNull();
    expect(queries.find(query => query.updates).updates.processing_status).toBe('failed');
    expect(queries.filter(query => query.deleted)).toHaveLength(2);
    expect(require('../../src/services/photoProcessor').processPhoto).not.toHaveBeenCalled();
  });

  it('retains accounting failures without turning a completed photo into failed/retryable work', async () => {
    const { db, queries } = makeFakeDb({ pendingRow: { id: 7 } });
    const finish = jest.fn().mockRejectedValue(new Error('capacity cleanup unavailable'));
    jest.doMock('../../src/services/imageWorkAdmission', () => ({ finish }));
    process.env.UPLOAD_PROCESSOR_CONCURRENCY = '1';
    let bg;
    try {
      bg = loadProcessor(db);
      require('../../src/services/photoProcessor').processPhoto.mockImplementation(async () => { void bg.stop(); });
      bg.start();
      await new Promise(resolve => setImmediate(resolve));
      await bg.stop();
      expect(finish).toHaveBeenCalledWith(7);
      expect(queries.some(query => query.updates?.processing_status === 'failed')).toBe(false);
    } finally {
      if (bg) await bg.stop();
      delete process.env.UPLOAD_PROCESSOR_CONCURRENCY;
      jest.dontMock('../../src/services/imageWorkAdmission');
    }
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
    expect(result).toMatchObject({ ...pendingRow, processing_status: 'processing', processing_attempt_id: expect.any(String) });
    // SQLite path: no FOR UPDATE / SKIP LOCKED.
    expect(queries[0].locked).toBe(false);
    expect(queries[0].skipped).toBe(false);
    expect(queries.find((q) => q.updates).updates.processing_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
