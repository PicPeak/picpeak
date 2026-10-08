/**
 * Execution attempts against a real database (bootCrmDb), on any platform:
 * the claim, the fence, recovery by age where the host has no kernel leases
 * and by lease where it has, and the housekeeping when an attempt ends.
 * The kernel-lease branches are driven through the capability record with
 * the lease addon stubbed.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('media execution attempts', () => {
  let db, cleanup, eventId, attempts, capabilities, kernelLease, processLease, dir;
  const id = rows => rows[0]?.id ?? rows[0];
  const photo = async (over = {}) => id(await db('photos').insert({
    event_id: eventId, filename: `p-${Date.now()}-${Math.random()}.jpg`, path: 'events/active/p.jpg', type: 'individual',
    size_bytes: 1000, uploaded_at: new Date().toISOString(), processing_status: 'pending', ...over,
  }).returning('id'));
  const row = photoId => db('photos').where({ id: photoId }).first();
  const records = () => db('media_process_attempts');
  const ago = ms => new Date(Date.now() - ms).toISOString();
  const cutoff = () => ago(600000);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = id(await db('events').insert({ slug: 'attempts', event_type: 'wedding', event_name: 'Attempts',
      event_date: '2026-10-08', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/attempts/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId }).returning('id'));
    attempts = require('../../src/services/mediaAttemptService');
    capabilities = require('../../src/services/mediaCapabilities');
    kernelLease = require('../../src/services/linuxKernelLease');
    processLease = require('../../src/services/linuxProcessLease');
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-attempts-')));
  }, 60000);
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); if (cleanup) await cleanup(); });
  beforeEach(async () => {
    await db('photos').delete(); await records().delete();
    capabilities.set({ guard: false, leases: false });
  });
  afterEach(() => { jest.restoreAllMocks(); capabilities.set(null); });

  describe('without kernel leases: macOS, Docker Desktop bind mounts, NFS, no compiled addon (item 3)', () => {
    test('a photo that was pending before the upgrade is claimed, processed and committed like any other (item 7)', async () => {
      // No attempt id, no attempt record, no reservation of any kind.
      const photoId = await photo();
      expect(await row(photoId)).toMatchObject({ processing_attempt_id: null, processing_attempts: 0 });
      const claimed = await attempts.claimNext('photo');
      expect(claimed).toMatchObject({ id: photoId, processing_status: 'processing', processing_attempts: 1, processing_attempt_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(await records()).toEqual([expect.objectContaining({ id: claimed.processing_attempt_id, photo_id: photoId, kind: 'photo', lease_path: '' })]);
      const result = await attempts.execute(claimed, 'photo', async attempt => {
        await attempt.assertCurrent();
        expect(attempts.current()).toBe(attempt);
        return attempts.guard(attempt, db, true).update({ processing_status: 'complete' });
      });
      expect(result).toBe(1);
      expect((await row(photoId)).processing_status).toBe('complete');
      // Housekeeping (item 11): nothing is left of a finished attempt.
      expect(await records()).toEqual([]);
    });

    test('a result is only written by the attempt that owns the row (execution fencing)', async () => {
      const photoId = await photo();
      const first = await attempts.claimNext('photo');
      await attempts.execute(first, 'photo', async attempt => {
        // A retry or replacement hands the row to a new attempt meanwhile.
        await db('photos').where({ id: photoId }).update({ processing_status: 'pending', processing_attempt_id: null });
        await expect(attempt.assertCurrent()).rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
        expect(await attempts.guard(attempt, db, true).update({ processing_status: 'complete', thumbnail_path: 'late.jpg' })).toBe(0);
      });
      expect(await row(photoId)).toMatchObject({ processing_status: 'pending', thumbnail_path: null });
      // Output names carry the attempt, so a late worker cannot overwrite a newer file.
      expect(attempts.outputName('IMG 1.jpg', { id: first.processing_attempt_id })).toBe(`IMG 1_${first.processing_attempt_id}.jpg`);
    });

    test('a stuck row is recovered by age, as the janitors always did', async () => {
      const old = await photo({ processing_status: 'processing', processing_started_at: ago(700000) });
      const recent = await photo({ processing_status: 'processing', processing_started_at: ago(5000) });
      // A numeric timestamp from a process that died long ago sorts below any ISO text.
      const legacy = await photo({ processing_status: 'processing', processing_started_at: Date.now() - 900000 });
      expect(await attempts.recover('photo', cutoff())).toBe(2);
      expect((await row(old)).processing_status).toBe('pending');
      expect((await row(legacy)).processing_status).toBe('pending');
      expect((await row(recent)).processing_status).toBe('processing');
      expect(await attempts.claimNext('photo')).toMatchObject({ id: old });
    });

    test('rows whose attempt was recorded under an unknown host are recovered once their heartbeat has stopped (item 5)', async () => {
      const stuck = await photo({ processing_status: 'processing', processing_started_at: ago(30000), processing_attempt_id: 'a0000000-0000-4000-8000-000000000001' });
      const working = await photo({ processing_status: 'processing', processing_started_at: ago(7200000), processing_attempt_id: 'a0000000-0000-4000-8000-000000000002' });
      const record = { kind: 'photo', owner_json: JSON.stringify({ host: null }), children_json: '[]', lease_path: '', lease_device: '', lease_inode: '', lease_filesystem: '', state: 'active' };
      await records().insert([
        { ...record, id: 'a0000000-0000-4000-8000-000000000001', photo_id: stuck, heartbeat_at: ago(attempts.HEARTBEAT_STALE_MS + 5000), created_at: ago(300000) },
        // Hours old, but its worker still reports in: it is left alone.
        { ...record, id: 'a0000000-0000-4000-8000-000000000002', photo_id: working, heartbeat_at: ago(3000), created_at: ago(7200000) },
      ]);
      expect(await attempts.recover('photo', cutoff())).toBe(1);
      expect(await row(stuck)).toMatchObject({ processing_status: 'pending', processing_started_at: null });
      expect((await row(working)).processing_status).toBe('processing');
      expect((await records()).map(item => item.id)).toEqual(['a0000000-0000-4000-8000-000000000002']);
    });

    test('an attempt running in this process is never recovered from under itself', async () => {
      const photoId = await photo();
      const claimed = await attempts.claimNext('photo');
      await db('photos').where({ id: photoId }).update({ processing_started_at: ago(86400000) });
      await db('media_process_attempts').update({ heartbeat_at: ago(86400000) });
      await attempts.execute(claimed, 'photo', async () => {
        expect(await attempts.recover('photo', cutoff())).toBe(0);
        expect((await row(photoId)).processing_status).toBe('processing');
      });
    });
  });

  describe('no head-of-line blocking (item 6)', () => {
    test('a row whose earlier attempt is still running is skipped, and the queue behind it moves on', async () => {
      const first = await photo();
      const second = await photo();
      const claimed = await attempts.claimNext('photo');
      expect(claimed.id).toBe(first);
      await attempts.execute(claimed, 'photo', async () => {
        // Put back to pending (a replacement) while its old attempt still runs.
        await db('photos').where({ id: first }).update({ processing_status: 'pending' });
        expect(await attempts.claimNext('photo')).toMatchObject({ id: second });
        // Nothing else is due; the busy row is still not handed out twice.
        expect(await attempts.claimNext('photo')).toBeNull();
      });
      // Once the old attempt has ended the row is claimable again.
      expect(await attempts.claimNext('photo')).toMatchObject({ id: first });
    });

    test('an earlier attempt whose end cannot be shown does not hold its row: the new claim supersedes it', async () => {
      const photoId = await photo();
      await records().insert({ id: 'b0000000-0000-4000-8000-000000000001', photo_id: photoId, kind: 'photo', owner_json: JSON.stringify({ host: 'another-host' }),
        children_json: '[]', lease_path: '', lease_device: '', lease_inode: '', lease_filesystem: '', state: 'active', heartbeat_at: ago(1000), created_at: ago(1000) });
      const claimed = await attempts.claimNext('photo');
      expect(claimed).toMatchObject({ id: photoId });
      expect((await records()).map(item => item.id)).toEqual([claimed.processing_attempt_id]);
    });
  });

  describe('attempt limit and due time', () => {
    test('a row is not claimed before its retry time and is recorded as failed after five claims', async () => {
      const later = await photo({ processing_retry_at: new Date(Date.now() + 60000).toISOString() });
      expect(await attempts.claimNext('photo')).toBeNull();
      // An explicit request for that row is not held back by the pause.
      expect(await attempts.claimNext('photo', later)).toMatchObject({ id: later });
      const spent = await photo({ processing_attempts: attempts.MAX_ATTEMPTS });
      expect(attempts.MAX_ATTEMPTS).toBe(5);
      expect(await attempts.claimNext('photo')).toEqual({ exhausted: spent });
      expect(await row(spent)).toMatchObject({ processing_status: 'failed', processing_error: 'Image processing did not complete after 5 attempts' });
    });
  });

  describe('with kernel leases (item 2, 3, 11; Linux branch, addon stubbed)', () => {
    let held, identity;
    beforeEach(() => {
      held = new Map();
      capabilities.set({ guard: false, leases: true, leaseRoot: dir });
      identity = { host: 'this-host', bootId: '11111111-1111-4111-8111-111111111111', pidNamespace: 'pid:[1]', pid: process.pid, startTicks: '1' };
      jest.spyOn(processLease, 'currentIdentity').mockImplementation(async () => ({ ...identity }));
      jest.spyOn(processLease, 'proveTermination').mockResolvedValue('dead');
      jest.spyOn(kernelLease, 'acquire').mockImplementation(async leasePath => {
        await fs.writeFile(leasePath, ''); held.set(leasePath, true);
        return { path: leasePath, device: '10', inode: String(held.size), filesystem: '61267', release: async () => { held.set(leasePath, false); } };
      });
      jest.spyOn(kernelLease, 'probe').mockImplementation(async leasePath => held.get(leasePath) === true ? 'busy' : held.has(leasePath) ? 'free' : 'unknown');
    });

    test('the claim holds a lease in the local lease directory; ending the attempt releases and removes it', async () => {
      const photoId = await photo();
      const claimed = await attempts.claimNext('photo');
      const leasePath = path.join(dir, `${claimed.processing_attempt_id}.owner.lease`);
      expect(await records().first()).toMatchObject({ lease_path: leasePath, lease_device: '10', lease_filesystem: '61267' });
      expect(JSON.parse((await records().first()).owner_json)).toMatchObject({ host: 'this-host', volumeMarker: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(held.get(leasePath)).toBe(true);
      let childLease;
      await attempts.execute(claimed, 'photo', async attempt => {
        // A guarded tool registers its own lease with the attempt and clears it when it ends.
        const hooks = attempt.hooks({ lease: true });
        childLease = hooks.leasePath;
        expect(path.dirname(childLease)).toBe(dir);
        await fs.writeFile(childLease, '');
        await hooks.onStart({ pid: 4242, startTicks: '9', device: '10', inode: '77', filesystem: '61267' });
        expect(JSON.parse((await records().first()).children_json)).toEqual([expect.objectContaining({ pid: 4242, leasePath: childLease, terminated: false })]);
        await hooks.onFinish();
        await expect(fs.stat(childLease)).rejects.toMatchObject({ code: 'ENOENT' });
        // An unguarded tool has no lease to register.
        expect(attempt.hooks({ lease: false }).leasePath).toBeUndefined();
      });
      expect(held.get(leasePath)).toBe(false);
      await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await records()).toEqual([]);
      expect((await row(photoId)).processing_attempt_id).toBe(claimed.processing_attempt_id);
    });

    test('a crashed worker is recovered at once when its lease is free, and never while it is held', async () => {
      // Two attempts of another backend process on this host.
      await fs.writeFile(path.join(dir, '.volume-id'), require('crypto').randomUUID(), { flag: 'wx' }).catch(() => {});
      const volumeMarker = (await fs.readFile(path.join(dir, '.volume-id'), 'utf8')).trim();
      const other = async (attemptId, busy) => {
        const photoId = await photo({ processing_status: 'processing', processing_started_at: ago(2000), processing_attempt_id: attemptId });
        const leasePath = path.join(dir, `${attemptId}.owner.lease`);
        await fs.writeFile(leasePath, ''); held.set(leasePath, busy);
        await records().insert({ id: attemptId, photo_id: photoId, kind: 'photo', owner_json: JSON.stringify({ ...identity, pid: 999999, volumeMarker }),
          children_json: '[]', lease_path: leasePath, lease_device: '10', lease_inode: '1', lease_filesystem: '61267', state: 'active',
          heartbeat_at: ago(1000), created_at: ago(2000) });
        return { photoId, leasePath };
      };
      const crashed = await other('c1000000-0000-4000-8000-000000000001', false);
      const live = await other('c1000000-0000-4000-8000-000000000002', true);
      // Both started seconds ago and both still "heartbeat": only the lease tells them apart.
      expect(await attempts.recover('photo', cutoff())).toBe(1);
      expect((await row(crashed.photoId)).processing_status).toBe('pending');
      expect((await row(live.photoId)).processing_status).toBe('processing');
      await expect(fs.stat(crashed.leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
      // The live one stays put even when it is hours old and silent.
      await db('photos').where({ id: live.photoId }).update({ processing_started_at: ago(86400000) });
      await records().update({ heartbeat_at: ago(86400000) });
      expect(await attempts.recover('photo', cutoff())).toBe(0);
      expect((await row(live.photoId)).processing_status).toBe('processing');
      // A lease file that vanished (a restarted container's /tmp) settles nothing: by age.
      held.delete(live.leasePath);
      expect(await attempts.recover('photo', cutoff())).toBe(1);
    });

    test('a lease directory that stops accepting leases does not stop claims: the attempt runs without one', async () => {
      kernelLease.acquire.mockRejectedValue(Object.assign(new Error('refused'), { code: 'MEDIA_LEASE_UNAVAILABLE' }));
      const photoId = await photo();
      const claimed = await attempts.claimNext('photo');
      expect(claimed).toMatchObject({ id: photoId, processing_status: 'processing' });
      expect((await records().first()).lease_path).toBe('');
      await expect(attempts.execute(claimed, 'photo', async () => 'ran')).resolves.toBe('ran');
    });

    test('the janitor reaps records and lease files of dead attempts that no row refers to (item 11)', async () => {
      const photoId = await photo({ processing_status: 'complete' });
      const orphanLease = path.join(dir, 'c0000000-0000-4000-8000-000000000001.owner.lease');
      const childLease = path.join(dir, 'c0000000-0000-4000-8000-000000000001.d0000000-0000-4000-8000-000000000009.child.lease');
      const strayLease = path.join(dir, 'e0000000-0000-4000-8000-000000000001.exec.lease');
      const youngLease = path.join(dir, 'f0000000-0000-4000-8000-000000000001.exec.lease');
      for (const file of [orphanLease, childLease, strayLease, youngLease]) { await fs.writeFile(file, ''); held.set(file, false); }
      const longAgo = new Date(Date.now() - 3600000);
      await fs.utimes(strayLease, longAgo, longAgo);
      await records().insert({ id: 'c0000000-0000-4000-8000-000000000001', photo_id: photoId, kind: 'photo',
        owner_json: JSON.stringify({ ...identity, pid: 999999, volumeMarker: (await fs.readFile(path.join(dir, '.volume-id'), 'utf8').catch(() => null)) }),
        children_json: JSON.stringify([{ leasePath: childLease, terminated: true }]), lease_path: orphanLease, lease_device: '10', lease_inode: '1', lease_filesystem: '61267',
        state: 'active', heartbeat_at: ago(900000), created_at: ago(900000) });
      expect(await attempts.recover('photo', cutoff())).toBe(0);
      expect(await records()).toEqual([]);
      for (const file of [orphanLease, childLease, strayLease]) await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      // A lease file that may be mid-claim is left for a later pass.
      await expect(fs.stat(youngLease)).resolves.toBeDefined();
    });
  });

  describe('superseded outputs (item 11)', () => {
    test('an attempt-named file a newer attempt replaced is deleted; names without an attempt id never are', async () => {
      const storage = { delete: jest.fn(async () => {}) };
      const previous = 'thumbnails/thumb_IMG_1_11111111-1111-4111-8111-111111111111.jpg';
      await attempts.dropSuperseded(storage, previous, 'thumbnails/thumb_IMG_1_22222222-2222-4222-8222-222222222222.jpg');
      expect(storage.delete).toHaveBeenCalledWith(previous);
      storage.delete.mockClear();
      await attempts.dropSuperseded(storage, 'thumbnails/thumb_IMG_1.jpg', 'thumbnails/thumb_IMG_1_22222222-2222-4222-8222-222222222222.jpg');
      await attempts.dropSuperseded(storage, previous, previous);
      await attempts.dropSuperseded(storage, null, previous);
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  test('a restore resets imported attempts inside the caller\'s transaction and knows no removed table', async () => {
    const photoId = await photo({ processing_status: 'processing', processing_attempt_id: 'a0000000-0000-4000-8000-00000000000a', processing_attempts: 3,
      processing_retry_at: ago(1000) });
    await db.transaction(trx => attempts.resetImportedMediaAttempts(trx));
    expect(await row(photoId)).toMatchObject({ processing_status: 'pending', processing_attempt_id: null, processing_attempts: 0, processing_retry_at: null });
    for (const table of ['image_work_lock', 'image_work_reservations', 'media_video_work_reservations']) expect(await db.schema.hasTable(table)).toBe(false);
    const source = await fs.readFile(path.join(__dirname, '../../src/services/mediaAttemptService.js'), 'utf8');
    expect(source).not.toMatch(/image_work_|media_video_work_reservations/);
  });
});
