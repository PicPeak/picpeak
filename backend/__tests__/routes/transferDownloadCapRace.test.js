/**
 * A transfer's download cap holds under concurrent requests.
 *
 * Both download routes checked the cap on the transfer they had just read and
 * counted afterwards; the single-file route only counted once the file had
 * streamed. Parallel requests all passed the same snapshot, so a "disable after
 * N downloads" link served more than N. The claim is now one conditional
 * UPDATE made before anything streams.
 */
const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let app;
let transferService;

async function makeTransfer(maxDownloads) {
  await transferService.createTransfer({ title: `Race ${maxDownloads}`, maxDownloads }, null);
  return db('transfers').orderBy('id', 'desc').first();
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  // Under jest a service's `new Date()` binds as a foreign-realm Date that
  // node-sqlite3 stringifies; normalise bindings the same way the other
  // service-level suites do.
  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map(
        (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
      );
    }
    return origQuery.call(this, connection, obj);
  };
  const flag = await db('feature_flags').where({ key: 'transfers' }).first();
  if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'transfers', value: true });
  transferService = require('../../src/services/transferService');
  app = buildRouteApp('/api/public/transfer', require('../../src/routes/publicTransfer'));
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('transfer download cap under concurrent requests', () => {
  it('serves the ZIP no more often than the cap allows', async () => {
    const transfer = await makeTransfer(3);

    const responses = await Promise.all(Array.from({ length: 8 }, () => (
      request(app).get(`/api/public/transfer/${transfer.token}/download`)
    )));

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 410)).toHaveLength(5);
    const row = await db('transfers').where({ id: transfer.id }).first();
    expect(Number(row.download_count)).toBe(3);
    expect(Boolean(row.is_active)).toBe(false);
    expect(await db('transfer_downloads').where({ transfer_id: transfer.id })).toHaveLength(3);
  });

  it('serves a single file no more often than the cap allows', async () => {
    const transfer = await makeTransfer(2);
    const storage = require('../../src/services/storage').getStorage();
    const key = `transfers/race-${transfer.id}/note.txt`;
    await storage.put(key, Buffer.from('hello'));
    const extraId = await transferService.addExtraFile(transfer.id, {
      originalFilename: 'note.txt', storedPath: key, sizeBytes: 5, mimeType: 'text/plain',
    });

    const responses = await Promise.all(Array.from({ length: 6 }, () => (
      request(app).get(`/api/public/transfer/${transfer.token}/download/x${extraId}`)
    )));

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 410)).toHaveLength(4);
    expect(Number((await db('transfers').where({ id: transfer.id }).first()).download_count)).toBe(2);
  });

  it('does not use up a download for a file that does not exist', async () => {
    const transfer = await makeTransfer(2);

    const res = await request(app).get(`/api/public/transfer/${transfer.token}/download/x999999`);

    expect(res.status).toBe(404);
    expect(Number((await db('transfers').where({ id: transfer.id }).first()).download_count)).toBe(0);
  });
});
