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
  // The templates are seeded at boot in production; without them a mail that
  // should go out fails instead, and the send cases below could not tell.
  await require('../../src/services/crmEmailTemplates').ensureCrmEmailTemplatesSeeded(db, require('../../src/utils/logger'));
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
  // The branches the tests above leave out, and the mails that must still go
  // out: a check that cancelled too much would pass every test above.
  const sendQueued = async (emailType) => {
    const { processEmailQueue } = require('../../src/services/emailProcessor');
    const row = await db('email_queue').where({ email_type: emailType, status: 'pending' }).orderBy('id', 'desc').first();
    expect(row).toBeTruthy();
    const stub = stubWebhookTransport();
    try {
      await processEmailQueue({ ignoreSchedule: true, onlyId: row.id });
    } finally { stub.restore(); }
    return { mails: stub.mails, after: await db('email_queue').where({ id: row.id }).first() };
  };
  const admin = () => ({ id: adminId, username: 'tester' });

  it('sends a document-shared mail when the document is still shared', async () => {
    const { notifyShared } = require('../../src/services/customerDocumentNotifications');
    const doc = await insertDocument({ shared_at: new Date().toISOString() });
    expect(await notifyShared(doc)).toBe('queued');

    const { mails, after } = await sendQueued('customer_document_shared');
    expect(mails).toHaveLength(1);
    expect(after.status).toBe('sent');
  });

  it('sends the mail for a document shared again after an unshare', async () => {
    const { notifyShared } = require('../../src/services/customerDocumentNotifications');
    const { setShared } = require('../../src/services/customerDocumentsService');
    const doc = await insertDocument({ shared_at: new Date().toISOString() });
    await setShared(customerId, doc.id, false, admin());
    await setShared(customerId, doc.id, true, admin());
    expect(await notifyShared(await db('customer_documents').where({ id: doc.id }).first())).toBe('queued');

    const { mails, after } = await sendQueued('customer_document_shared');
    expect(mails).toHaveLength(1);
    expect(after.status).toBe('sent');
  });

  it('drops a rejection mail once the upload has been accepted after all, and sends it while still rejected', async () => {
    const { notifyRejected } = require('../../src/services/customerDocumentNotifications');
    const { review } = require('../../src/services/customerDocumentsService');

    const reversed = await insertDocument({ uploader_type: 'customer', uploader_id: customerId, status: 'rejected', review_note: 'Blurry' });
    expect(await notifyRejected(reversed)).toBe('queued');
    await review(customerId, reversed.id, { status: 'clean' }, admin());
    const dropped = await sendQueued('customer_document_reviewed');
    expect(dropped.mails).toHaveLength(0);
    expect(dropped.after.status).toBe('cancelled');
    expect(dropped.after.error_message).toMatch(/reviewed again/);

    const kept = await insertDocument({ uploader_type: 'customer', uploader_id: customerId, status: 'rejected', review_note: 'Blurry' });
    expect(await notifyRejected(kept)).toBe('queued');
    const sent = await sendQueued('customer_document_reviewed');
    expect(sent.mails).toHaveLength(1);
    expect(sent.after.status).toBe('sent');
  });

  it('drops the studio\'s upload mail once the upload has been deleted', async () => {
    const businessProfileService = require('../../src/services/businessProfileService');
    const profile = jest.spyOn(businessProfileService, 'getProfile').mockResolvedValue({ profile: { email: 'studio@example.com' } });
    try {
      const { notifyUploaded } = require('../../src/services/customerDocumentNotifications');
      const { softDelete } = require('../../src/services/customerDocumentsService');
      const doc = await insertDocument({ uploader_type: 'customer', uploader_id: customerId });
      expect(await notifyUploaded(doc)).toBe('queued');
      await softDelete(customerId, doc.id, admin());

      const { mails, after } = await sendQueued('customer_document_uploaded_admin');
      expect(mails).toHaveLength(0);
      expect(after.status).toBe('cancelled');
      expect(after.error_message).toMatch(/deleted/);
    } finally { profile.mockRestore(); }
  });

  it('drops the first request mail once the request has been cancelled, and sends it while open', async () => {
    const requestsService = require('../../src/services/customerDocumentRequestsService');
    const { notifyRequest } = require('../../src/services/customerDocumentNotifications');

    const cancelled = await requestsService.create(customerId, { title: 'Passport' }, admin());
    expect(await notifyRequest(cancelled)).toBe('queued');
    await requestsService.cancel(customerId, cancelled.id, admin());
    const dropped = await sendQueued('customer_document_requested');
    expect(dropped.mails).toHaveLength(0);
    expect(dropped.after.status).toBe('cancelled');

    const open = await requestsService.create(customerId, { title: 'Invoice address' }, admin());
    expect(await notifyRequest(open)).toBe('queued');
    const sent = await sendQueued('customer_document_requested');
    expect(sent.mails).toHaveLength(1);
    expect(sent.after.status).toBe('sent');
  });
});
