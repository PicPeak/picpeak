/**
 * A customer document notification is queued as soon as the write it
 * reports on commits (customerDocumentNotifications.js), but the document
 * or request can change state before the queue processor gets to the row —
 * an admin unshares or deletes the document, or a request is fulfilled or
 * cancelled. #1591: the customer used to get a mail whose link answers 410,
 * or that names a document/request already taken back.
 *
 * The fix re-checks the row right before send (emailProcessor.js,
 * staleDocumentNotificationReason) and cancels the queued mail instead of
 * sending it — the same status: 'cancelled' convention already used for a
 * newsletter recipient who opts out after their campaign was queued.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'stale-doc-notif-test-secret';

const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

let db;
let cleanup;
let customerId;
let adminId;

const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);

function stubWebhookTransport() {
  const transport = require('../../src/services/emailWebhookTransport');
  const savedFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'noreply@example.com';
  const mails = [];
  const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
  const send = jest.spyOn(transport, 'send').mockImplementation(async (mail) => { mails.push(mail); return { messageId: `m-${mails.length}` }; });
  return {
    mails,
    restore() {
      enabled.mockRestore(); send.mockRestore();
      if (savedFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = savedFrom;
    },
  };
}

async function insertDocument(overrides = {}) {
  const now = new Date().toISOString();
  const ins = await db('customer_documents').insert({
    customer_account_id: customerId,
    uploader_type: 'admin',
    uploader_id: adminId,
    original_name: 'contract.pdf',
    storage_key: `business-docs/customer-documents/${customerId}/${randomUUID()}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 1234,
    sha256: 'a'.repeat(64),
    status: 'clean',
    created_at: now,
    updated_at: now,
    ...overrides,
  }).returning('id');
  return db('customer_documents').where({ id: idOf(ins) }).first();
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  await db('feature_flags').where({ key: 'documents' }).update({ value: 1 });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('customer document notifications, checked again at send time (#1591)', () => {
  it('drops a document-shared mail once the document has been unshared', async () => {
    const { notifyShared } = require('../../src/services/customerDocumentNotifications');
    const { setShared } = require('../../src/services/customerDocumentsService');
    const { processEmailQueue } = require('../../src/services/emailProcessor');

    const doc = await insertDocument({ shared_at: new Date().toISOString() });

    const queued = await notifyShared(doc);
    expect(queued).toBe('queued');
    const row = await db('email_queue')
      .where({ email_type: 'customer_document_shared', status: 'pending' })
      .orderBy('id', 'desc').first();
    expect(row).toBeTruthy();
    expect(JSON.parse(row.email_data).__documentId).toBe(doc.id);

    // The admin takes the share back before the queue processor runs.
    await setShared(customerId, doc.id, false, { id: adminId, username: 'tester' });

    const stub = stubWebhookTransport();
    try {
      await processEmailQueue({ ignoreSchedule: true, onlyId: row.id });
    } finally { stub.restore(); }

    expect(stub.mails).toHaveLength(0);
    const after = await db('email_queue').where({ id: row.id }).first();
    expect(after.status).toBe('cancelled');
    expect(after.error_message).toMatch(/unshared/);
  });

  it('drops a document-shared mail once the document has been deleted', async () => {
    const { notifyShared } = require('../../src/services/customerDocumentNotifications');
    const { softDelete } = require('../../src/services/customerDocumentsService');
    const { processEmailQueue } = require('../../src/services/emailProcessor');

    const doc = await insertDocument({ shared_at: new Date().toISOString() });
    await notifyShared(doc);
    const row = await db('email_queue')
      .where({ email_type: 'customer_document_shared', status: 'pending' })
      .orderBy('id', 'desc').first();

    await softDelete(customerId, doc.id, { id: adminId, username: 'tester' });

    const stub = stubWebhookTransport();
    try {
      await processEmailQueue({ ignoreSchedule: true, onlyId: row.id });
    } finally { stub.restore(); }

    expect(stub.mails).toHaveLength(0);
    const after = await db('email_queue').where({ id: row.id }).first();
    expect(after.status).toBe('cancelled');
    expect(after.error_message).toMatch(/deleted/);
  });

  it('drops a request-reminder mail once the request has been fulfilled', async () => {
    const requestsService = require('../../src/services/customerDocumentRequestsService');
    const { notifyRequest } = require('../../src/services/customerDocumentNotifications');
    const { processEmailQueue } = require('../../src/services/emailProcessor');

    const request = await requestsService.create(customerId, { title: 'Signed contract' }, { id: adminId, username: 'tester' });
    const queued = await notifyRequest(request, { reminder: true });
    expect(queued).toBe('queued');
    const row = await db('email_queue')
      .where({ email_type: 'customer_document_request_reminder', status: 'pending' })
      .orderBy('id', 'desc').first();
    expect(row).toBeTruthy();
    expect(JSON.parse(row.email_data).__requestId).toBe(request.id);

    // Fulfilled by an upload before the reminder is actually sent.
    const doc = await insertDocument();
    await db.transaction((trx) => requestsService.fulfilInTransaction(trx, customerId, request.id, doc.id));

    const stub = stubWebhookTransport();
    try {
      await processEmailQueue({ ignoreSchedule: true, onlyId: row.id });
    } finally { stub.restore(); }

    expect(stub.mails).toHaveLength(0);
    const after = await db('email_queue').where({ id: row.id }).first();
    expect(after.status).toBe('cancelled');
    expect(after.error_message).toMatch(/fulfilled or cancelled/);
  });

  it('drops a request-reminder mail once the request has been cancelled', async () => {
    const requestsService = require('../../src/services/customerDocumentRequestsService');
    const { notifyRequest } = require('../../src/services/customerDocumentNotifications');
    const { processEmailQueue } = require('../../src/services/emailProcessor');

    const request = await requestsService.create(customerId, { title: 'ID copy' }, { id: adminId, username: 'tester' });
    await notifyRequest(request, { reminder: true });
    const row = await db('email_queue')
      .where({ email_type: 'customer_document_request_reminder', status: 'pending' })
      .orderBy('id', 'desc').first();

    await requestsService.cancel(customerId, request.id, { id: adminId, username: 'tester' });

    const stub = stubWebhookTransport();
    try {
      await processEmailQueue({ ignoreSchedule: true, onlyId: row.id });
    } finally { stub.restore(); }

    expect(stub.mails).toHaveLength(0);
    const after = await db('email_queue').where({ id: row.id }).first();
    expect(after.status).toBe('cancelled');
    expect(after.error_message).toMatch(/fulfilled or cancelled/);
  });
});
