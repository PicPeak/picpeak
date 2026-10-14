/**
 * A transfer hands out only photos the background worker has finished, as the
 * gallery does (its list and every bulk download leave out a photo still
 * processing, or one that failed).
 *
 * Before: the recipient page, the ZIP of originals and the single-file route
 * read the transfer's photos through the live-photo join alone, so a photo
 * picked while it was still processing (or whose processing failed) was
 * listed and delivered.
 */
const request = require('supertest');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let publicApp; let transferService; let storage; let adminId;
const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

/** Entry names from the ZIP's central directory. */
function zipEntryNames(buffer) {
  const names = [];
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buffer.readUInt32LE(eocd + 16);
  const count = buffer.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i += 1) {
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  // Under jest a service's `new Date()` binds as a foreign-realm Date that
  // node-sqlite3 stringifies; normalise bindings the way the other transfer
  // suites do.
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
  storage = require('../../src/services/storage').getStorage();
  publicApp = buildRouteApp('/api/public/transfer', require('../../src/routes/publicTransfer'));
});

afterAll(async () => { if (cleanup) await cleanup(); });

/** A transfer with one finished, one processing and one failed photo. */
async function seedTransfer(slug) {
  const [ev] = await db('events').insert({
    slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
    host_email: 'h@e.com', admin_email: 'a@e.com', password_hash: 'x',
    share_token: `t-${slug}`, share_link: `/g/${slug}`, created_by: adminId,
    expires_at: new Date(Date.now() + 864e5).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  const eventId = ev?.id ?? ev;
  const photo = async (filename, processingStatus) => {
    const [ph] = await db('photos').insert({
      event_id: eventId, filename, path: `${slug}/individual/${filename}`, type: 'individual',
      mime_type: 'image/jpeg', size_bytes: 5, uploaded_at: new Date().toISOString(),
      processing_status: processingStatus,
    }).returning('id');
    await storage.put(`events/active/${slug}/individual/${filename}`, Buffer.from(`${filename}!`));
    return ph?.id ?? ph;
  };
  const done = await photo('done.jpg', 'complete');
  const pending = await photo('pending.jpg', 'pending');
  const failed = await photo('failed.jpg', 'failed');
  await transferService.createTransfer({ title: slug, maxDownloads: null }, null);
  const transfer = await db('transfers').orderBy('id', 'desc').first();
  const fileIds = {};
  let order = 0;
  for (const [name, photoId] of Object.entries({ done, pending, failed })) {
    const [fid] = await db('transfer_files').insert({ transfer_id: transfer.id, photo_id: photoId, sort_order: order += 1 }).returning('id');
    fileIds[name] = fid?.id ?? fid;
  }
  return { transfer, fileIds };
}

describe('public transfer', () => {
  it('lists only finished photos', async () => {
    const { transfer, fileIds } = await seedTransfer('unprocessed-list');
    const view = await transferService.getPublicView(transfer);
    const ids = view.files.map((f) => f.file_id);
    expect(ids).toEqual([`p${fileIds.done}`]);
  });

  it('zips only finished photos', async () => {
    const { transfer } = await seedTransfer('unprocessed-zip');
    const res = await request(publicApp)
      .get(`/api/public/transfer/${transfer.token}/download`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const names = zipEntryNames(res.body);
    expect(names.some((n) => n.endsWith('done.jpg'))).toBe(true);
    expect(names.some((n) => n.endsWith('pending.jpg') || n.endsWith('failed.jpg'))).toBe(false);
  });

  it('refuses a ZIP with nothing finished yet without using up a download', async () => {
    const { transfer } = await seedTransfer('unprocessed-empty');
    await db('photos').whereIn('id', db('transfer_files').where({ transfer_id: transfer.id }).select('photo_id'))
      .update({ processing_status: 'pending' });
    await db('transfers').where({ id: transfer.id }).update({ max_downloads: 1 });
    const res = await request(publicApp).get(`/api/public/transfer/${transfer.token}/download`);
    expect(res.status).toBe(404);
    const row = await db('transfers').where({ id: transfer.id }).first();
    expect(Number(row.download_count)).toBe(0);
  });

  it('announces only the files the recipient can download', async () => {
    const { transfer } = await seedTransfer('unprocessed-email');
    const emailProcessor = require('../../src/services/emailProcessor');
    const spy = jest.spyOn(emailProcessor, 'sendTemplateEmail').mockResolvedValue(undefined);
    try {
      await transferService.sendTransferEmails(transfer.id, ['recipient@example.com']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2].file_count).toBe('1');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a single photo that is still processing or failed, and serves a finished one', async () => {
    const { transfer, fileIds } = await seedTransfer('unprocessed-single');
    for (const name of ['pending', 'failed']) {
      const res = await request(publicApp).get(`/api/public/transfer/${transfer.token}/download/p${fileIds[name]}`);
      expect(res.status).toBe(404);
    }
    const ok = await request(publicApp)
      .get(`/api/public/transfer/${transfer.token}/download/p${fileIds.done}`).buffer(true).parse(binary);
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe('done.jpg!');
    // The refusals did not use up downloads: only the served file counted.
    const row = await db('transfers').where({ id: transfer.id }).first();
    expect(Number(row.download_count)).toBe(1);
  });
});
