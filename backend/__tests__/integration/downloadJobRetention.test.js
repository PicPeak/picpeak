/**
 * Prepared downloads: retention setting, deliverability sweep and the
 * "email me when it is ready" mail (issue 1733).
 *
 * Pins the contract:
 *  - a job's lifetime follows the retention setting, one hour by default
 *  - the setting only takes a whole number of hours within bounds
 *  - the sweep drops finished archives nobody can be handed any more and
 *    keeps the ones that still can, and survives a file that is already gone
 *  - the mail goes to the address the instance holds for the requester, never
 *    to one in the request; once per address and job; capped per hour
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'download-retention-test-secret';

describe('Prepared downloads: retention, sweep and ready mail (issue 1733)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken;
  let jpeg;
  let jobs;
  let notifier;
  let decodeSettingValue;
  let invalidateDownloadGlobals;
  let counter = 0;

  const HOUR = 3600 * 1000;

  const galleryToken = (event, extra = {}) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent({ photos = 2 } = {}) {
    counter += 1;
    const slug = `retention-test-${counter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Retention Test ${counter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `retention-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      download_resolution_picker_enabled: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];

    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    const photoIds = [];
    for (let i = 0; i < photos; i += 1) {
      const filename = `photo-${i}.jpg`;
      await fs.promises.writeFile(path.join(dir, filename), jpeg);
      const p = await db('photos').insert({
        event_id: id,
        filename,
        path: `${slug}/${filename}`,
        type: 'individual',
        media_type: 'image',
        mime_type: 'image/jpeg',
        size_bytes: jpeg.length,
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }
    return { event: await db('events').where({ id }).first(), photoIds };
  }

  // A job row as the service writes it, so the delivery fingerprint matches.
  async function makeJob(event, photoIds, { status = 'ready', scope = 'public', expiresIn = 24 * HOUR } = {}) {
    counter += 1;
    const token = String(counter).padStart(64, 'f');
    const { resolveWatermarkSettings } = require('../../src/services/downloadRendition');
    const zipKey = jobs.jobKey(event.slug, token);
    if (status === 'ready') {
      const abs = path.join(process.env.STORAGE_PATH, zipKey);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, Buffer.from('PK'));
    }
    await db('download_jobs').insert({
      token,
      event_id: event.id,
      resolution: 'original',
      photo_ids: JSON.stringify(photoIds),
      delivered_photo_ids: JSON.stringify(photoIds),
      dedup_key: jobs.dedupKey(event.id, 'original', photoIds, await resolveWatermarkSettings(event), scope),
      visibility_scope: scope,
      status,
      zip_path: status === 'ready' ? zipKey : null,
      photo_count: photoIds.length,
      heartbeat_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + expiresIn).toISOString(),
    });
    return db('download_jobs').where({ token }).first();
  }

  const exists = (key) => fs.existsSync(path.join(process.env.STORAGE_PATH, key));
  const jobRow = (id) => db('download_jobs').where({ id }).first();

  async function verifiedGuest(event, email, { verified = true } = {}) {
    counter += 1;
    const inserted = await db('gallery_guests').insert({
      event_id: event.id,
      name: 'Guest',
      email,
      identifier: `guest-${counter}`,
      email_verified_at: verified ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    }).returning('id');
    const guestId = inserted[0]?.id ?? inserted[0];
    return require('../../src/middleware/guestAuth')
      .signGuestToken({ guestId, eventId: event.id, identifier: `guest-${counter}`, name: 'Guest' });
  }

  const askForMail = (event, job, guestToken, body = {}) => {
    const req = request(app)
      .post(`/api/gallery/${event.slug}/download-jobs/${job.token}/notify`)
      .set('Authorization', `Bearer ${galleryToken(event)}`);
    if (guestToken) req.set('x-guest-token', guestToken);
    return req.send(body);
  };

  // What recipientFor() hands the notifier for this guest.
  const guestRecipient = async (email) => {
    const guest = await db('gallery_guests').where({ email }).first();
    return { email: guest.email.toLowerCase(), guestId: guest.id };
  };

  const readyMails = (email) => db('email_queue').where({ email_type: 'download_ready', recipient_email: email });

  const setRetention = async (hours) => {
    await db('app_settings').where({ setting_key: 'download_job_retention_hours' }).del();
    if (hours !== undefined) {
      await db('app_settings').insert({
        setting_key: 'download_job_retention_hours',
        setting_value: JSON.stringify(hours),
        setting_type: 'download',
        updated_at: new Date().toISOString(),
      });
    }
    invalidateDownloadGlobals();
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    jobs = require('../../src/services/downloadJobService');
    notifier = require('../../src/services/downloadJobNotifier');
    ({ decodeSettingValue } = require('../../src/services/eventSettings'));
    ({ invalidateDownloadGlobals } = require('../../src/utils/downloadResolutions'));
    await require('../../src/services/galleryDeliveryTemplates').ensureGalleryDeliveryTemplatesSeeded(db, null);

    jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 80, b: 200 } },
    }).jpeg().toBuffer();

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'retention-admin',
      email: 'retention-admin@example.com',
      password_hash: await bcrypt.hash('RetentionAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'retention-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('retention setting', () => {
    const save = (body) => request(app)
      .put('/api/admin/settings/downloads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

    afterEach(() => setRetention(undefined));

    it('keeps a job for one hour unless the setting says otherwise', async () => {
      const { event } = await makeEvent();
      const before = Date.now();
      const job = await jobs.createJob({ event, resolution: 'original', photoIds: null, accessLevel: 'guest' });
      await jobs.liveBuilds.get(job.id);
      const lifetime = new Date(job.expires_at).getTime() - before;
      expect(lifetime).toBeGreaterThan(HOUR - 5000);
      expect(lifetime).toBeLessThan(HOUR + 5000);
    });

    it('keeps a job for as long as the setting says', async () => {
      await setRetention(48);
      const { event } = await makeEvent();
      const before = Date.now();
      const job = await jobs.createJob({ event, resolution: 'original', photoIds: null, accessLevel: 'guest' });
      await jobs.liveBuilds.get(job.id);
      const lifetime = new Date(job.expires_at).getTime() - before;
      expect(lifetime).toBeGreaterThan(48 * HOUR - 5000);
      expect(lifetime).toBeLessThan(48 * HOUR + 5000);
      expect((await jobRow(job.id)).status).toBe('ready');
    });

    it('stores a whole number of hours within bounds and reports it', async () => {
      const res = await save({ download_job_retention_hours: 72 });
      expect(res.status).toBe(200);
      const row = await db('app_settings').where({ setting_key: 'download_job_retention_hours' }).first();
      expect(decodeSettingValue(row.setting_value)).toBe(72);

      const read = await request(app)
        .get('/api/admin/settings/downloads')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(read.body.job_retention_hours).toBe(72);
    });

    it.each([0, 169, 1.5, -3, 'soon', null])('refuses %p', async (value) => {
      await setRetention(24);
      const res = await save({ download_job_retention_hours: value });
      expect(res.status).toBe(400);
      const row = await db('app_settings').where({ setting_key: 'download_job_retention_hours' }).first();
      expect(decodeSettingValue(row.setting_value)).toBe(24);
    });

    it('falls back to one hour for a stored value that is out of bounds', async () => {
      await setRetention(100000);
      const { getDownloadGlobals } = require('../../src/utils/downloadResolutions');
      expect((await getDownloadGlobals()).job_retention_hours).toBe(1);
    });
  });

  describe('sweep', () => {
    it('keeps an archive that can still be delivered', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds);
      await jobs.sweepExpired();
      expect(await jobRow(job.id)).toBeTruthy();
      expect(exists(job.zip_path)).toBe(true);
    });

    it('drops an archive past its retention', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { expiresIn: -1000 });
      await jobs.sweepExpired();
      expect(await jobRow(job.id)).toBeUndefined();
      expect(exists(job.zip_path)).toBe(false);
    });

    it.each([
      ['expired', { expires_at: new Date(Date.now() - HOUR).toISOString() }],
      ['archived', { is_archived: 1 }],
      ['deactivated', { is_active: 0 }],
      ['closed for downloads', { allow_downloads: 0 }],
    ])('drops the archive of a gallery that is %s', async (_label, change) => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds);
      await db('events').where({ id: event.id }).update(change);
      await jobs.sweepExpired();
      expect(await jobRow(job.id)).toBeUndefined();
      expect(exists(job.zip_path)).toBe(false);
    });

    it('drops an archive holding a photo that was hidden or deleted since', async () => {
      const { event, photoIds } = await makeEvent({ photos: 3 });
      const hidden = await makeJob(event, photoIds.slice(0, 2));
      const untouched = await makeJob(event, [photoIds[2]]);
      await db('photos').where({ id: photoIds[0] }).update({ visibility: 'hidden' });
      await jobs.sweepExpired();
      expect(await jobRow(hidden.id)).toBeUndefined();
      expect(exists(hidden.zip_path)).toBe(false);
      // The same gallery's other archive holds nothing that changed.
      expect(await jobRow(untouched.id)).toBeTruthy();
      expect(exists(untouched.zip_path)).toBe(true);
    });

    it('keeps a client archive whose hidden photo a guest could not see', async () => {
      const { event, photoIds } = await makeEvent();
      await db('photos').where({ id: photoIds[0] }).update({ visibility: 'hidden' });
      const job = await makeJob(event, photoIds, { scope: 'hidden' });
      await jobs.sweepExpired();
      expect(await jobRow(job.id)).toBeTruthy();
    });

    it('leaves a build in progress alone', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      await db('events').where({ id: event.id }).update({ allow_downloads: 0 });
      await jobs.sweepExpired();
      expect(await jobRow(job.id)).toBeTruthy();
    });

    it('takes the waiting recipients with the job', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { expiresIn: -1000 });
      await db('download_job_recipients').insert({
        job_id: job.id, email: 'gone@example.com', created_at: new Date().toISOString(),
      });
      await jobs.sweepExpired();
      expect(await db('download_job_recipients').where({ job_id: job.id })).toHaveLength(0);
    });

    it('cancels the ready mail of a swept job that has not gone out yet, and only that one', async () => {
      const { event, photoIds } = await makeEvent();
      const swept = await makeJob(event, photoIds, { status: 'building' });
      const kept = await makeJob(event, photoIds, { status: 'building' });
      const guestToken = await verifiedGuest(event, 'backlog@example.com');
      for (const job of [swept, kept]) {
        await askForMail(event, job, guestToken);
        await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
        await notifier.notifyReady(job.id);
      }
      expect(await readyMails('backlog@example.com')).toHaveLength(2);

      // The queue was held up for longer than the retention of one of them.
      await db('download_jobs').where({ id: swept.id })
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() });
      await jobs.sweepExpired();

      const mails = await readyMails('backlog@example.com');
      const statusOf = (job) => mails.find((m) => String(m.email_data).includes(job.token)).status;
      expect(statusOf(swept)).toBe('cancelled');
      expect(statusOf(kept)).toBe('pending');
    });

    it('two replicas sweeping at once, and a file already gone, are not errors', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { expiresIn: -1000 });
      await fs.promises.unlink(path.join(process.env.STORAGE_PATH, job.zip_path));
      await expect(Promise.all([jobs.sweepExpired(), jobs.sweepExpired()])).resolves.toBeDefined();
      expect(await jobRow(job.id)).toBeUndefined();
    });
  });

  describe('ready mail', () => {
    it('is offered to a guest with a verified address and sent there, once', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      const guestToken = await verifiedGuest(event, 'Verified@Example.com');

      const status = () => request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${job.token}`)
        .set('Authorization', `Bearer ${galleryToken(event)}`)
        .set('x-guest-token', guestToken);
      expect((await status()).body.notify).toBe('available');

      // An address in the body is not an input of this route.
      const res = await askForMail(event, job, guestToken, { email: 'victim@example.com' });
      expect(res.status).toBe(200);
      expect((await status()).body.notify).toBe('requested');
      // Asking twice leaves one recipient.
      expect((await askForMail(event, job, guestToken)).status).toBe(200);
      const recipients = await db('download_job_recipients').where({ job_id: job.id });
      expect(recipients.map((r) => r.email)).toEqual(['verified@example.com']);

      await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
      // Two replicas noticing the finished job mail the recipient once.
      await Promise.all([notifier.notifyReady(job.id), notifier.notifyReady(job.id)]);
      await notifier.notifyReady(job.id);

      const mails = await readyMails('verified@example.com');
      expect(mails).toHaveLength(1);
      expect(await readyMails('victim@example.com')).toHaveLength(0);
      // Due at once on both engines: NULL, never a text timestamp.
      expect(mails[0].scheduled_at).toBeNull();
      expect(Number(mails[0].event_id)).toBe(event.id);
      // The link is the gallery, carrying the job for it to offer; not the file.
      const link = new URL(JSON.parse(mails[0].email_data).gallery_link);
      expect(link.searchParams.get('download_job')).toBe(job.token);
      expect(link.pathname).toContain('/gallery/');
      expect(link.pathname).not.toContain('download-jobs');
    });

    it('is not offered for an address the guest only typed', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      const guestToken = await verifiedGuest(event, 'typed@example.com', { verified: false });

      const status = await request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${job.token}`)
        .set('Authorization', `Bearer ${galleryToken(event)}`)
        .set('x-guest-token', guestToken);
      expect(status.body.notify).toBeUndefined();

      expect((await askForMail(event, job, guestToken, { email: 'typed@example.com' })).status).toBe(403);
      expect((await askForMail(event, job, null, { email: 'anyone@example.com' })).status).toBe(403);
      expect(await db('download_job_recipients').where({ job_id: job.id })).toHaveLength(0);
    });

    it('ignores a verified guest of another gallery', async () => {
      const other = await makeEvent();
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      const foreignGuest = await verifiedGuest(other.event, 'elsewhere@example.com');
      expect((await askForMail(event, job, foreignGuest)).status).toBe(403);
    });

    it('mails the customer account behind a portal session', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      const acct = await db('customer_accounts').insert({
        email: 'portal-download@example.com',
        password_hash: 'x',
        is_active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const customerId = acct[0]?.id ?? acct[0];
      await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: customerId });

      const res = await request(app)
        .post(`/api/gallery/${event.slug}/download-jobs/${job.token}/notify`)
        .set('Authorization', `Bearer ${galleryToken(event, { via: 'customer', customerId })}`)
        .send({ email: 'victim@example.com' });
      expect(res.status).toBe(200);

      await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
      await notifier.notifyReady(job.id);
      expect(await readyMails('portal-download@example.com')).toHaveLength(1);
      expect(await readyMails('victim@example.com')).toHaveLength(0);
    });

    it('mails each requester of a shared job', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      await askForMail(event, job, await verifiedGuest(event, 'first@example.com'));
      await askForMail(event, job, await verifiedGuest(event, 'second@example.com'));
      await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
      await notifier.notifyReady(job.id);
      expect(await readyMails('first@example.com')).toHaveLength(1);
      expect(await readyMails('second@example.com')).toHaveLength(1);
    });

    it('caps how many mails one address may ask for per hour', async () => {
      const { event, photoIds } = await makeEvent();
      const guestToken = await verifiedGuest(event, 'eager@example.com');
      for (let i = 0; i < notifier.MAX_REQUESTS_PER_HOUR; i += 1) {
        const job = await makeJob(event, photoIds, { status: 'building' });
        expect((await askForMail(event, job, guestToken)).status).toBe(200);
      }
      const oneTooMany = await makeJob(event, photoIds, { status: 'building' });
      expect((await askForMail(event, oneTooMany, guestToken)).status).toBe(429);
      expect(await db('download_job_recipients').where({ job_id: oneTooMany.id })).toHaveLength(0);

      // Requests older than the hour no longer count.
      await db('download_job_recipients').where({ email: 'eager@example.com' })
        .update({ created_at: new Date(Date.now() - 2 * HOUR).toISOString() });
      expect((await askForMail(event, oneTooMany, guestToken)).status).toBe(200);
    });

    it('refuses a job that is no longer being prepared', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds);
      const res = await askForMail(event, job, await verifiedGuest(event, 'late@example.com'));
      expect(res.status).toBe(409);
    });

    it('mails a requester whose job finished while they were asking', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      // The row the caller read says building; the build has finished since.
      await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
      await verifiedGuest(event, 'race@example.com');
      expect(await notifier.request(job, await guestRecipient('race@example.com'))).toBe('requested');
      expect(await readyMails('race@example.com')).toHaveLength(1);
    });

    it('holds the hourly cap when the requests arrive at once', async () => {
      const { event, photoIds } = await makeEvent();
      const guestToken = await verifiedGuest(event, 'burst@example.com');
      const burst = [];
      for (let i = 0; i < notifier.MAX_REQUESTS_PER_HOUR + 3; i += 1) {
        burst.push(await makeJob(event, photoIds, { status: 'building' }));
      }
      const statuses = (await Promise.all(burst.map((job) => askForMail(event, job, guestToken))))
        .map((res) => res.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(notifier.MAX_REQUESTS_PER_HOUR);
      expect(statuses.filter((status) => status === 429)).toHaveLength(3);
      expect(await db('download_job_recipients').where({ email: 'burst@example.com' }))
        .toHaveLength(notifier.MAX_REQUESTS_PER_HOUR);
    });

    it('is not offered for a client job, which the link in the mail could not reach', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building', scope: 'hidden' });
      const guestToken = await verifiedGuest(event, 'client@example.com');
      const client = `Bearer ${galleryToken(event, { accessLevel: 'client' })}`;

      const status = await request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${job.token}`)
        .set('Authorization', client).set('x-guest-token', guestToken);
      expect(status.status).toBe(200);
      expect(status.body.notify).toBeUndefined();

      const res = await request(app)
        .post(`/api/gallery/${event.slug}/download-jobs/${job.token}/notify`)
        .set('Authorization', client).set('x-guest-token', guestToken).send({});
      expect(res.status).toBe(403);
      expect(await db('download_job_recipients').where({ job_id: job.id })).toHaveLength(0);
    });

    it('keeps a recipient whose mail could not be queued, and mails them on the next pass', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      await askForMail(event, job, await verifiedGuest(event, 'retry@example.com'));
      await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });

      const emailProcessor = require('../../src/services/emailProcessor');
      const queueEmail = jest.spyOn(emailProcessor, 'queueEmail').mockRejectedValueOnce(new Error('queue down'));
      try {
        expect(await notifier.notifyReady(job.id)).toBe(0);
      } finally {
        queueEmail.mockRestore();
      }
      expect(await readyMails('retry@example.com')).toHaveLength(0);
      const [waiting] = await db('download_job_recipients').where({ job_id: job.id });
      expect(waiting.notified_at).toBeNull();

      // The cleanup pass is what retries.
      await require('../../src/services/downloadJobCleanupService').runDownloadJobCleanup();
      expect(await readyMails('retry@example.com')).toHaveLength(1);
    });

    it('a queued mail is not sent once its archive is gone', async () => {
      const { event, photoIds } = await makeEvent();
      const guestToken = await verifiedGuest(event, 'held-up@example.com');
      const [gone, live] = [
        await makeJob(event, photoIds, { status: 'building' }),
        await makeJob(event, photoIds, { status: 'building' }),
      ];
      // A second requester of the live job, deactivated while the mail waited.
      const acct = await db('customer_accounts').insert({
        email: 'held-up-account@example.com',
        password_hash: 'x',
        is_active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const customerId = acct[0]?.id ?? acct[0];
      await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: customerId });
      await request(app)
        .post(`/api/gallery/${event.slug}/download-jobs/${live.token}/notify`)
        .set('Authorization', `Bearer ${galleryToken(event, { via: 'customer', customerId })}`)
        .send({}).expect(200);
      for (const job of [gone, live]) {
        await askForMail(event, job, guestToken);
        await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
        await notifier.notifyReady(job.id);
      }
      await db('customer_accounts').where({ id: customerId }).update({ is_active: 0 });
      // The queue was held up; one archive ran out before the sweep got to it.
      await db('download_jobs').where({ id: gone.id })
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const transport = require('../../src/services/emailWebhookTransport');
      const savedFrom = process.env.EMAIL_FROM;
      process.env.EMAIL_FROM = 'noreply@example.com';
      const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
      const sentTo = [];
      const send = jest.spyOn(transport, 'send')
        .mockImplementation(async (mail) => { sentTo.push(mail); return { messageId: 'm-1' }; });
      try {
        await db('email_queue').whereNotIn('recipient_email', ['held-up@example.com', 'held-up-account@example.com'])
          .whereIn('status', ['pending']).update({ status: 'cancelled' });
        await require('../../src/services/emailProcessor').processEmailQueue();
      } finally {
        enabled.mockRestore(); send.mockRestore();
        if (savedFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = savedFrom;
      }

      const mails = await readyMails('held-up@example.com');
      const statusOf = (job) => mails.find((m) => String(m.email_data).includes(job.token)).status;
      expect(statusOf(gone)).toBe('cancelled');
      expect(statusOf(live)).toBe('sent');
      expect(sentTo).toHaveLength(1);
      const [toAccount] = await readyMails('held-up-account@example.com');
      expect(toAccount.status).toBe('cancelled');
    });

    it('does not announce an archive that can no longer be delivered', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      await askForMail(event, job, await verifiedGuest(event, 'stale@example.com'));
      // A packaged photo was hidden while the build ran.
      await db('photos').where({ id: photoIds[0] }).update({ visibility: 'hidden' });
      await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
      expect(await notifier.notifyReady(job.id)).toBe(0);
      expect(await readyMails('stale@example.com')).toHaveLength(0);
    });

    it('does not mail a job that is past its retention', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      await askForMail(event, job, await verifiedGuest(event, 'toolate@example.com'));
      await db('download_jobs').where({ id: job.id })
        .update({ status: 'ready', expires_at: new Date(Date.now() - 1000).toISOString() });
      expect(await notifier.notifyReady(job.id)).toBe(0);
      expect(await readyMails('toolate@example.com')).toHaveLength(0);
    });
  });

  describe('ready mail and erasure', () => {
    it('customer erasure drops the request, so the finished job mails nobody', async () => {
      const { event, photoIds } = await makeEvent();
      const building = await makeJob(event, photoIds, { status: 'building' });
      const earlier = await makeJob(event, photoIds, { status: 'building' });
      const acct = await db('customer_accounts').insert({
        email: 'erase-me@example.com',
        password_hash: 'x',
        is_active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const customerId = acct[0]?.id ?? acct[0];
      await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: customerId });
      const portal = `Bearer ${galleryToken(event, { via: 'customer', customerId })}`;
      for (const job of [building, earlier]) {
        const res = await request(app)
          .post(`/api/gallery/${event.slug}/download-jobs/${job.token}/notify`)
          .set('Authorization', portal).send({});
        expect(res.status).toBe(200);
      }
      // One of the two was mailed before the erasure.
      await db('download_jobs').where({ id: earlier.id }).update({ status: 'ready' });
      await notifier.notifyReady(earlier.id);
      expect(await readyMails('erase-me@example.com')).toHaveLength(1);
      // Under Jest the queue's Date lands in SQLite as "[object Object]"
      // (CLAUDE.md), which no time window can read; erasure bounds this
      // account's mail by its creation time, so give the row a real one.
      await db('email_queue').where({ recipient_email: 'erase-me@example.com' })
        .update({ created_at: new Date().toISOString() });

      await require('../../src/services/customerAccountsService').eraseCustomer(customerId, null);
      expect(await db('download_job_recipients').where({ email: 'erase-me@example.com' })).toHaveLength(0);
      expect(await db('download_job_recipients').where({ customer_account_id: customerId })).toHaveLength(0);

      await db('download_jobs').where({ id: building.id }).update({ status: 'ready' });
      expect(await notifier.notifyReady(building.id)).toBe(0);
      expect(await readyMails('erase-me@example.com')).toHaveLength(0);
    });

    it('"forget me" drops a guest\'s request and the ready mail already queued for them', async () => {
      const { event, photoIds } = await makeEvent();
      const building = await makeJob(event, photoIds, { status: 'building' });
      const earlier = await makeJob(event, photoIds, { status: 'building' });
      const guestToken = await verifiedGuest(event, 'forget-me@example.com');
      const { guestId } = await guestRecipient('forget-me@example.com');
      await askForMail(event, building, guestToken);
      await askForMail(event, earlier, guestToken);
      await db('download_jobs').where({ id: earlier.id }).update({ status: 'ready' });
      await notifier.notifyReady(earlier.id);
      expect(await readyMails('forget-me@example.com')).toHaveLength(1);

      const res = await request(app)
        .delete(`/api/gallery/${event.slug}/guest/me`)
        .set('Authorization', `Bearer ${galleryToken(event)}`)
        .set('x-guest-token', guestToken);
      expect(res.status).toBe(200);

      expect(await db('download_job_recipients').where({ guest_id: guestId })).toHaveLength(0);
      expect(await readyMails('forget-me@example.com')).toHaveLength(0);
      const [scrubbed] = await db('email_queue').where({ event_id: event.id, email_type: 'download_ready' });
      expect(scrubbed.status).toBe('cancelled');
      expect(scrubbed.email_data).not.toContain('forget-me');

      await db('download_jobs').where({ id: building.id }).update({ status: 'ready' });
      expect(await notifier.notifyReady(building.id)).toBe(0);
      expect(await db('email_queue').where({ event_id: event.id, email_type: 'download_ready' })).toHaveLength(1);
    });

    it('does not record a request whose owner was removed while it was on its way', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      const guestToken = await verifiedGuest(event, 'inflight@example.com');
      // What the route read from the session just before the guest was removed.
      const recipient = await guestRecipient('inflight@example.com');
      await request(app)
        .delete(`/api/gallery/${event.slug}/guest/me`)
        .set('Authorization', `Bearer ${galleryToken(event)}`)
        .set('x-guest-token', guestToken)
        .expect(200);

      expect(await notifier.request(job, recipient)).toBe('gone');
      expect(await db('download_job_recipients').where({ job_id: job.id })).toHaveLength(0);
    });

    it('deleting the gallery takes the requests with it', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      await askForMail(event, job, await verifiedGuest(event, 'deleted-gallery@example.com'));
      expect(await db('download_job_recipients').where({ job_id: job.id })).toHaveLength(1);

      await require('../../src/routes/adminEvents/helpers').deleteEventCascade(event.id, { id: null });
      expect(await db('download_job_recipients').where({ job_id: job.id })).toHaveLength(0);
    });

    it('does not mail an owner who no longer holds the address', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds, { status: 'building' });
      await askForMail(event, job, await verifiedGuest(event, 'moved@example.com'));
      // Removed on a path that did not clean up after itself (a merge).
      await db('gallery_guests').where({ email: 'moved@example.com' }).update({ is_deleted: 1 });
      await db('download_jobs').where({ id: job.id }).update({ status: 'ready' });
      expect(await notifier.notifyReady(job.id)).toBe(0);
      expect(await readyMails('moved@example.com')).toHaveLength(0);
      expect(await db('download_job_recipients').where({ job_id: job.id })).toHaveLength(0);
    });
  });

  describe('resume link', () => {
    it('says so when a ready job is past its retention but not swept yet', async () => {
      const { event, photoIds } = await makeEvent();
      const status = (job) => request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${job.token}`)
        .set('Authorization', `Bearer ${galleryToken(event)}`);
      const live = await status(await makeJob(event, photoIds));
      expect(live.body).toMatchObject({ status: 'ready' });
      expect(live.body.unavailable).toBeUndefined();
      const gone = await status(await makeJob(event, photoIds, { expiresIn: -1000 }));
      expect(gone.body).toMatchObject({ status: 'ready', unavailable: true });
    });

    it('says so when the gallery changed under a ready job, or the job is another scope\'s', async () => {
      const { event, photoIds } = await makeEvent();
      const status = (job) => request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${job.token}`)
        .set('Authorization', `Bearer ${galleryToken(event)}`);
      const clientJob = await makeJob(event, photoIds, { scope: 'hidden' });
      expect((await status(clientJob)).body).toMatchObject({ status: 'ready', unavailable: true });

      const job = await makeJob(event, photoIds);
      expect((await status(job)).body.unavailable).toBeUndefined();
      await db('photos').where({ id: photoIds[0] }).update({ visibility: 'hidden' });
      expect((await status(job)).body).toMatchObject({ status: 'ready', unavailable: true });
    });

    it('says so when downloads were switched off since', async () => {
      const { event, photoIds } = await makeEvent();
      const job = await makeJob(event, photoIds);
      const auth = `Bearer ${galleryToken(event)}`;
      await db('events').where({ id: event.id }).update({ allow_downloads: 0 });
      const status = await request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${job.token}`).set('Authorization', auth);
      expect(status.body).toMatchObject({ status: 'ready', unavailable: true });
      // What the flag stands for: the file route refuses.
      const file = await request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${job.token}/file`).set('Authorization', auth);
      expect(file.status).toBe(403);
    });
  });
});
