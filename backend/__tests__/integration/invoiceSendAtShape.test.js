/**
 * An invoice's send date is stored in one shape, so the API returns text and
 * the scheduler finds every invoice that is due.
 *
 * On SQLite, node-sqlite3 binds a Date as epoch milliseconds. Creating an
 * invoice stored such a number, and the API returned it, so the invoice
 * page's `scheduledSendAt.slice` threw. Editing the send date stored text
 * instead, and SQLite sorts every number below every text value: the
 * scheduler, which compared against a Date, never found an edited invoice
 * due, so it was never sent.
 *
 * The other invoice suites turn Date bindings into ISO text, which hides
 * both. This one binds them the way the driver does in production: epoch
 * milliseconds on SQLite (the jest sandbox would otherwise store
 * "[object Object]"), and ISO text on PostgreSQL, where the column is a real
 * timestamp either way.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let customerId; let token;
let invoiceApp; let scheduler; let isSqlite;
const prevCwd = process.cwd();

const auth = () => ({ Authorization: `Bearer ${token}` });
const DAY = 24 * 60 * 60 * 1000;
// The editor sends a zone-less 'YYYY-MM-DDTHH:mm', cut from the stored UTC
// value (BillEditorPage), so it means UTC.
const editorValue = (ms) => new Date(ms).toISOString().slice(0, 16);

async function scheduledInvoice(sendAt) {
  const res = await request(invoiceApp).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    scheduledSendAt: sendAt,
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: 10000, discountPercent: 0 }],
  });
  expect(res.status).toBe(201);
  return Number(res.body.invoiceIds ? res.body.invoiceIds[0] : res.body.invoice.id);
}

const statusOf = async (id) => (await db('invoices').where({ id }).first('status')).status;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  isSqlite = /sqlite/.test(String(db.client.config.client));

  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map((b) => {
        if (!(b && typeof b === 'object' && typeof b.toISOString === 'function')) return b;
        return isSqlite ? b.getTime() : b.toISOString();
      });
    }
    return origQuery.call(this, connection, obj);
  };
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });

  scheduler = require('../../src/services/invoice/scheduler');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('invoice send date', () => {
  it('comes back from the API as ISO text after create', async () => {
    const sendAt = new Date(Date.now() + 3 * DAY).toISOString();
    const id = await scheduledInvoice(sendAt);
    const res = await request(invoiceApp).get(`/api/admin/invoices/${id}`).set(auth());
    expect(res.status).toBe(200);
    const value = (res.body.invoice || res.body).scheduledSendAt;
    expect(typeof value).toBe('string');
    expect(new Date(value).toISOString()).toBe(sendAt);
  });

  it('an edited send date that has passed is sent by the scheduler, a future one waits', async () => {
    const due = await scheduledInvoice(new Date(Date.now() + 5 * DAY).toISOString());
    const later = await scheduledInvoice(new Date(Date.now() + 5 * DAY).toISOString());
    const edit = async (id, value) => {
      const res = await request(invoiceApp).put(`/api/admin/invoices/${id}`).set(auth()).send({ scheduledSendAt: value });
      expect(res.status).toBe(200);
    };
    await edit(due, editorValue(Date.now() - DAY));
    await edit(later, editorValue(Date.now() + 2 * DAY));

    await scheduler.runScheduledTasks();

    expect(await statusOf(due)).toBe('sent');
    expect(await statusOf(later)).toBe('scheduled');
  });

  it('saving the editor value unchanged keeps the same instant, in any server zone', async () => {
    const sendAt = new Date(Date.UTC(2030, 0, 1, 9, 0)).toISOString();
    const id = await scheduledInvoice(sendAt);
    const shown = (await request(invoiceApp).get(`/api/admin/invoices/${id}`).set(auth())).body;
    const field = (shown.invoice || shown).scheduledSendAt.slice(0, 16);
    for (let save = 0; save < 2; save += 1) {
      const res = await request(invoiceApp).put(`/api/admin/invoices/${id}`).set(auth()).send({ scheduledSendAt: field });
      expect(res.status).toBe(200);
    }
    const stored = (await db('invoices').where({ id }).first('scheduled_send_at')).scheduled_send_at;
    expect(new Date(stored).toISOString()).toBe(sendAt);
  });

  it('a created invoice that is due is sent by the scheduler', async () => {
    const id = await scheduledInvoice(new Date(Date.now() - 60 * 1000).toISOString());
    await scheduler.runScheduledTasks();
    expect(await statusOf(id)).toBe('sent');
  });
});
