/**
 * The transfer_ready mail waits for something to download (issue 2061).
 *
 * Before: since a transfer hands out only finished photos, a transfer created
 * while every photo was still processing mailed "your files are ready" with
 * file_count 0, and nothing sent it again once the photos finished.
 */
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('transfer ready mail held while nothing is downloadable', () => {
  let db; let cleanup; let storage; let jpeg; let transferService; let photoProcessor; let send;
  let adminApp; let token;
  let afterQuery = null;
  let seq = 0;

  const now = () => new Date().toISOString();
  const firstId = (rows) => rows[0]?.id ?? rows[0];

  async function mkEvent() {
    seq += 1;
    const slug = `ready-held-${seq}`;
    const eventId = firstId(await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/t`, share_token: crypto.randomBytes(8).toString('hex'),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: now(),
    }).returning('id'));
    return db('events').where({ id: eventId }).first();
  }

  async function mkPhoto(event, processingStatus) {
    const filename = `photo-${crypto.randomUUID()}.jpg`;
    await storage.put(`events/active/${event.slug}/${filename}`, jpeg);
    return firstId(await db('photos').insert({
      event_id: event.id, filename, original_filename: filename, path: `${event.slug}/${filename}`,
      type: 'individual', media_type: 'image', mime_type: 'image/jpeg', size_bytes: jpeg.length,
      uploaded_at: now(), processing_status: processingStatus, visibility: 'visible',
    }).returning('id'));
  }

  /** A send transfer holding the given photos, as the create route builds it. */
  async function mkTransfer(photoIds) {
    await transferService.createTransfer({ title: `t-${seq}`, maxDownloads: null, deliveryMethod: 'email' }, null);
    const transfer = await db('transfers').orderBy('id', 'desc').first();
    let order = 0;
    for (const photoId of photoIds) {
      await db('transfer_files').insert({ transfer_id: transfer.id, photo_id: photoId, sort_order: order += 1, created_at: now() });
    }
    return transfer;
  }

  const recipients = async (transferId) => db('transfer_recipients').where({ transfer_id: transferId }).orderBy('id');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    // Under jest a service's `new Date()` binds as a foreign-realm Date that
    // node-sqlite3 stringifies; normalise bindings as the other transfer
    // suites do.
    const clientProto = Object.getPrototypeOf(db.client);
    const origQuery = clientProto._query;
    clientProto._query = function patchedQuery(connection, obj) {
      if (obj && Array.isArray(obj.bindings)) {
        obj.bindings = obj.bindings.map(
          (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
        );
      }
      const hook = afterQuery && afterQuery.match.test(obj?.sql || '') ? afterQuery : null;
      if (hook) afterQuery = null;
      const result = origQuery.call(this, connection, obj);
      if (!hook) return result;
      // Run the injected statement on the same connection once this query
      // has answered, before the service sees the answer.
      return result.then((answer) => origQuery.call(this, connection, hook.statement).then(() => answer));
    };
    jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#557799' } }).jpeg().toBuffer();
    storage = require('../../src/services/storage').getStorage();
    transferService = require('../../src/services/transferService');
    photoProcessor = require('../../src/services/photoProcessor');
    jest.spyOn(require('../../src/services/webhookService'), 'fire').mockResolvedValue();
    const flag = await db('feature_flags').where({ key: 'transfers' }).first();
    if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value: true });
    else await db('feature_flags').insert({ key: 'transfers', value: true });
    adminApp = buildRouteApp('/api/admin/transfers', require('../../src/routes/adminTransfers'));
  }, 180000);

  let wake;
  beforeEach(() => {
    send = jest.spyOn(require('../../src/services/emailProcessor'), 'sendTemplateEmail').mockResolvedValue(undefined);
    wake = jest.spyOn(transferService, 'sendHeldReadyEmailsForPhotos');
  });
  afterEach(() => { send.mockRestore(); wake.mockRestore(); });

  /** processPhoto does not wait for the held mail: wait for it here. */
  async function finish(photoId) {
    await photoProcessor.processPhoto(photoId);
    expect((await db('photos').where({ id: photoId }).first()).processing_status).toBe('complete');
    await Promise.all(wake.mock.results.map((r) => r.value));
  }

  afterAll(async () => {
    await require('../../src/services/downloadZipService').stop();
    if (cleanup) await cleanup();
  });

  it('holds the mail at 0 files and sends it once, when the first photo finishes', async () => {
    const event = await mkEvent();
    const first = await mkPhoto(event, 'pending');
    const second = await mkPhoto(event, 'pending');
    const transfer = await mkTransfer([first, second]);

    const result = await transferService.sendTransferEmails(transfer.id, ['anna@example.com', 'ben@example.com']);
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, held: true });
    // Recorded, so the detail panel lists them, but not sent yet.
    expect((await recipients(transfer.id)).map((r) => [r.email, r.last_sent_at])).toEqual([
      ['anna@example.com', null], ['ben@example.com', null],
    ]);
    // The admin view says which ones wait; the recipient page names none.
    expect((await transferService.getTransfer(transfer.id)).recipients.map((r) => [r.email, r.held])).toEqual([
      ['anna@example.com', true], ['ben@example.com', true],
    ]);
    expect(JSON.stringify(await transferService.getPublicView(transfer))).not.toMatch(/anna@example|held/);

    await finish(first);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => [c[0], c[1], c[2].file_count])).toEqual([
      ['anna@example.com', 'transfer_ready', '1'], ['ben@example.com', 'transfer_ready', '1'],
    ]);
    expect((await recipients(transfer.id)).every((r) => r.last_sent_at != null)).toBe(true);
    expect((await transferService.getTransfer(transfer.id)).recipients.every((r) => r.held === false)).toBe(true);

    // The next photo to finish sends nothing again.
    await finish(second);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a slow mail server does not hold the photo worker, but shutdown waits for it', async () => {
    const event = await mkEvent();
    const photo = await mkPhoto(event, 'pending');
    const transfer = await mkTransfer([photo]);
    await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    let sending;
    const sent = new Promise((resolve) => { sending = resolve; });
    let release;
    send.mockImplementation(() => { sending(); return new Promise((resolve) => { release = resolve; }); });
    // processPhoto returns while the SMTP send is still open.
    await photoProcessor.processPhoto(photo);
    await sent;
    // Still owned, so shutdown and a coordinated restore wait for it.
    const applicationWork = require('../../src/services/activeApplicationWork');
    let drained = false;
    const draining = applicationWork.drain().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release();
    await draining;
    await Promise.all(wake.mock.results.map((r) => r.value));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a held mail once when several callers race for it', async () => {
    const event = await mkEvent();
    const a = await mkPhoto(event, 'pending');
    const b = await mkPhoto(event, 'pending');
    const transfer = await mkTransfer([a, b]);
    await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    expect(send).not.toHaveBeenCalled();

    // Both photos finish at once, on two workers or two replicas.
    await db('photos').whereIn('id', [a, b]).update({ processing_status: 'complete' });
    await Promise.all([
      transferService.sendHeldReadyEmailsForPhotos([a]),
      transferService.sendHeldReadyEmailsForPhotos([b]),
      transferService.sendHeldReadyEmails(transfer.id),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while every photo has failed', async () => {
    const event = await mkEvent();
    const photo = await mkPhoto(event, 'pending');
    const transfer = await mkTransfer([photo]);
    await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    await db('photos').where({ id: photo }).update({ processing_status: 'failed' });
    await transferService.sendHeldReadyEmailsForPhotos([photo]);
    await transferService.sendHeldReadyEmails(transfer.id);
    expect(send).not.toHaveBeenCalled();
    expect((await recipients(transfer.id))[0].last_sent_at).toBeNull();
  });

  it('does not send a held mail for a link disabled meanwhile', async () => {
    const event = await mkEvent();
    const photo = await mkPhoto(event, 'pending');
    const transfer = await mkTransfer([photo]);
    await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    await db('transfers').where({ id: transfer.id }).update({ is_active: false });
    await finish(photo);
    expect(send).not.toHaveBeenCalled();
  });

  it('a send again while nothing is downloadable holds the mail as well', async () => {
    const event = await mkEvent();
    const done = await mkPhoto(event, 'complete');
    const transfer = await mkTransfer([done]);
    await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    expect(send).toHaveBeenCalledTimes(1);

    // The photo is replaced and back in the queue when the admin sends again.
    await db('photos').where({ id: done }).update({ processing_status: 'pending' });
    const result = await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    expect(result).toMatchObject({ sent: 0, held: true });
    expect(send).toHaveBeenCalledTimes(1);

    await finish(done);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2].file_count).toBe('1');
  });

  it('a photo restored from the trash sends the held mail', async () => {
    const event = await mkEvent();
    const photo = await mkPhoto(event, 'pending');
    const transfer = await mkTransfer([photo]);
    await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    // Trashed while its worker ran, which then finished it out of reach.
    await db('photos').where({ id: photo }).update({
      deleted_at: now(), purge_after: new Date(Date.now() + 864e5).toISOString(), processing_status: 'complete',
    });
    await transferService.sendHeldReadyEmailsForPhotos([photo]);
    expect(send).not.toHaveBeenCalled();

    const { restored } = await require('../../src/services/photoTrash').restorePhotos(event, [photo]);
    expect(restored).toEqual([photo]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a send again of a held recipient claims it, so a finishing photo does not mail it too', async () => {
    const event = await mkEvent();
    const done = await mkPhoto(event, 'complete');
    const transfer = await mkTransfer([done]);
    // Held earlier, while the photo was still processing.
    await db('transfer_recipients').insert({ transfer_id: transfer.id, email: 'anna@example.com', created_at: now(), last_sent_at: null });
    let sending;
    const inSmtp = new Promise((resolve) => { sending = resolve; });
    let release;
    send.mockImplementation(() => { sending(); return new Promise((resolve) => { release = resolve; }); });

    const resend = transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    await inSmtp;
    // Another photo of the transfer finishes while the resend is in SMTP.
    await transferService.sendHeldReadyEmailsForPhotos([done]);
    release();
    expect((await resend).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a send again does not mail a held recipient a photo claimed after the recipients were read', async () => {
    const event = await mkEvent();
    const done = await mkPhoto(event, 'complete');
    const transfer = await mkTransfer([done]);
    const [row] = await db('transfer_recipients').insert({
      transfer_id: transfer.id, email: 'anna@example.com', created_at: now(), last_sent_at: null,
    }).returning('id');
    // A finishing photo claims (and mails) the held row right after the
    // recipients were read, while the files are being counted.
    afterQuery = {
      match: /from [`"]transfer_extra_files[`"]/i,
      statement: {
        sql: 'update transfer_recipients set last_sent_at = ? where id = ? and last_sent_at is null',
        bindings: [now(), row?.id ?? row],
      },
    };
    const result = await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    expect(afterQuery).toBeNull();
    expect(result.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('still sends at once when a file is ready', async () => {
    const event = await mkEvent();
    const done = await mkPhoto(event, 'complete');
    const pending = await mkPhoto(event, 'pending');
    const transfer = await mkTransfer([done, pending]);
    const result = await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
    expect(result.sent).toBe(1);
    expect(send.mock.calls[0][2].file_count).toBe('1');
    await finish(pending);
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe('admin routes', () => {
    const admin = (method, url) => request(adminApp)[method](`/api/admin/transfers${url}`)
      .set('Authorization', `Bearer ${token}`);

    it('creating a send by email while every photo processes mails nothing, adding a finished photo mails it', async () => {
      const event = await mkEvent();
      const pending = await mkPhoto(event, 'pending');
      const created = await admin('post', '')
        .field('kind', 'send')
        .field('deliveryMethod', 'email')
        .field('photoIds', JSON.stringify([pending]))
        .field('recipientEmails', JSON.stringify(['anna@example.com']));
      expect(created.status).toBe(201);
      expect(send).not.toHaveBeenCalled();
      const id = created.body.data?.transfer?.id ?? created.body.transfer?.id;

      const resend = await admin('post', `/${id}/resend`).send({});
      expect(resend.status).toBe(200);
      expect(send).not.toHaveBeenCalled();
      expect((resend.body.data ?? resend.body).held).toBe(true);

      const done = await mkPhoto(event, 'complete');
      const added = await admin('post', `/${id}/files`).send({ photoIds: [done] });
      expect(added.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][2].file_count).toBe('1');

      await finish(pending);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('re-activating a link sends the mail held back while it was off', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event, 'pending');
      const transfer = await mkTransfer([photo]);
      await transferService.sendTransferEmails(transfer.id, ['anna@example.com']);
      await db('transfers').where({ id: transfer.id }).update({ is_active: false });
      await finish(photo);
      expect(send).not.toHaveBeenCalled();

      const res = await admin('patch', `/${transfer.id}`).send({ isActive: true });
      expect(res.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
