/**
 * Ownership guards for PicTransfer (#998 review, tracked as #1005).
 *
 * A transfer bundles ORIGINAL files and hands them out over an unauthenticated
 * token URL, so the two guards below are the only thing standing between a
 * scoped admin and every other admin's originals:
 *
 *   1. filterOwnedPhotoIds — a scoped admin may only bundle photos from events
 *      they own. Without it, arbitrary photo ids in the create/add-files body
 *      became a public download link to anyone's originals.
 *   2. listTransfers scoping + payload stripping — the list used to be unscoped
 *      AND to carry each row's download token, so any admin holding events.view
 *      could read another's token and fetch their originals without creating
 *      anything at all.
 *
 * Both were correct when merged. These tests exist so they stay that way: an
 * untested guard does not survive refactoring, which #999 demonstrated when the
 * same attribution fix landed in one component and was left stale in another.
 * Each case below fails against the pre-fix behaviour, not merely passes
 * against the current code.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-transferown-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'transferown-test-secret';

const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('PicTransfer ownership guards (#998)', () => {
  let db; let cleanup; let transferService;
  let editorA; let editorB; let superAdmin;
  let eventA; let eventB; let eventOwnerless;
  let photoA; let photoB; let photoOwnerless;

  const asEditor = (id) => ({ id, roleName: 'editor' });

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const r = await db('admin_users').insert({
      username, email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const mkEvent = async (slug, createdBy) => {
    const r = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@e.com', admin_email: 'a@e.com', password_hash: 'x',
      share_token: `t-${slug}`, share_link: `/g/${slug}/t-${slug}`,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const mkPhoto = async (eventId, filename) => {
    const r = await db('photos').insert({
      event_id: eventId, filename, path: `events/${eventId}/${filename}`,
      type: 'individual', uploaded_at: Date.now(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const mkTransfer = async (title, createdBy) => {
    const r = await db('transfers').insert({
      token: `tok-${title}-${'0'.repeat(50)}`.slice(0, 64),
      title, created_by: createdBy,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      download_count: 0, is_active: 1, grace_days: 7, allow_uploads: 0,
      delivery_method: 'link',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    transferService = require('../../src/services/transferService');

    editorA = await mkAdmin('xfer-a', 'editor');
    editorB = await mkAdmin('xfer-b', 'editor');
    superAdmin = await mkAdmin('xfer-root', 'super_admin');

    eventA = await mkEvent('xfer-own', editorA);
    eventB = await mkEvent('xfer-foreign', editorB);
    eventOwnerless = await mkEvent('xfer-legacy', null);

    photoA = await mkPhoto(eventA, 'own.jpg');
    photoB = await mkPhoto(eventB, 'foreign.jpg');
    photoOwnerless = await mkPhoto(eventOwnerless, 'legacy.jpg');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('filterOwnedPhotoIds', () => {
    it("drops photos from another admin's event", async () => {
      // The exfiltration path: these ids would otherwise be bundled into a
      // transfer and served over the public download token.
      const owned = await transferService.filterOwnedPhotoIds(asEditor(editorA), [photoB]);
      expect(owned).toEqual([]);
    });

    it("keeps photos from the caller's own event", async () => {
      const owned = await transferService.filterOwnedPhotoIds(asEditor(editorA), [photoA]);
      expect(owned).toEqual([photoA]);
    });

    it('keeps photos from an ownerless legacy event', async () => {
      // Parity with filterOwnedEventIds, which treats created_by IS NULL as
      // ownable by anyone — otherwise legacy events become unusable.
      const owned = await transferService.filterOwnedPhotoIds(asEditor(editorA), [photoOwnerless]);
      expect(owned).toEqual([photoOwnerless]);
    });

    it('keeps only the owned subset of a mixed request', async () => {
      const owned = await transferService.filterOwnedPhotoIds(
        asEditor(editorA), [photoA, photoB, photoOwnerless],
      );
      expect(owned.sort()).toEqual([photoA, photoOwnerless].sort());
      expect(owned).not.toContain(photoB);
    });

    it('drops ids that do not exist', async () => {
      const owned = await transferService.filterOwnedPhotoIds(asEditor(editorA), [999999]);
      expect(owned).toEqual([]);
    });

    it('leaves super_admin unrestricted', async () => {
      const owned = await transferService.filterOwnedPhotoIds(
        { id: superAdmin, roleName: 'super_admin' }, [photoA, photoB, photoOwnerless],
      );
      expect(owned.sort()).toEqual([photoA, photoB, photoOwnerless].sort());
    });
  });

  describe('addFiles gates on the same rule', () => {
    it("refuses to attach another admin's photo", async () => {
      // The guard has to sit in addFiles, not only at the route, because both
      // createTransfer and POST /:id/files funnel through it.
      const transferId = await mkTransfer('gate', editorA);
      await transferService.addFiles(transferId, [photoA, photoB], asEditor(editorA));

      const attached = await db('transfer_files')
        .where({ transfer_id: transferId }).pluck('photo_id');
      expect(attached).toContain(photoA);
      expect(attached).not.toContain(photoB);
    });
  });

  describe('listTransfers', () => {
    let mineId; let theirsId;

    beforeAll(async () => {
      mineId = await mkTransfer('mine', editorA);
      theirsId = await mkTransfer('theirs', editorB);
    });

    it("hides another admin's transfers from a scoped caller", async () => {
      const rows = await transferService.listTransfers({ admin: asEditor(editorA) });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(mineId);
      expect(ids).not.toContain(theirsId);
    });

    it('shows everything to super_admin', async () => {
      const rows = await transferService.listTransfers({
        admin: { id: superAdmin, roleName: 'super_admin' },
      });
      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([mineId, theirsId]));
    });

    it('never carries download or upload links in the list payload', async () => {
      // Defence in depth on top of the scoping above, and the layer most likely
      // to be undone by a "the list needs the link too" change. The token is a
      // bearer credential for the originals — detail only.
      const rows = await transferService.listTransfers({ admin: asEditor(editorA) });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).not.toHaveProperty('token');
        expect(row).not.toHaveProperty('upload_token');
        expect(row).not.toHaveProperty('download_url');
        expect(row).not.toHaveProperty('upload_url');
      }
    });
  });

  // The guard is a module-local middleware, so rather than stand up supertest
  // just to prove Express ordering, assert the contract at the source — the
  // same approach taken for the backup/restore contracts in #596. Ordering is
  // the whole mechanism here: `router.use('/:id', …)` registered after the
  // `/:id` routes would silently guard nothing while still looking present.
  describe('requireTransferOwnership registration', () => {
    const routerSrc = fs.readFileSync(
      path.join(__dirname, '../../src/routes/adminTransfers.js'), 'utf8',
    );

    it('mounts the ownership guard before every /:id route', () => {
      const guardAt = routerSrc.indexOf("router.use('/:id', requireTransferOwnership)");
      expect(guardAt).toBeGreaterThan(-1);

      const idRoutes = [...routerSrc.matchAll(/^router\.(get|post|patch|delete)\('\/:id/gm)];
      expect(idRoutes.length).toBeGreaterThan(0);
      for (const m of idRoutes) {
        expect(m.index).toBeGreaterThan(guardAt);
      }
    });

    it('answers missing and foreign ids identically, so it is not an existence oracle', () => {
      const guard = routerSrc.slice(
        routerSrc.indexOf('async function requireTransferOwnership'),
        routerSrc.indexOf('// List'),
      );
      // Both branches must 404. A 403 on foreign would confirm the row exists.
      const notFounds = [...guard.matchAll(/status\(404\)/g)];
      expect(notFounds.length).toBeGreaterThanOrEqual(2);
      expect(guard).not.toMatch(/status\(403\)/);
      expect(guard).toMatch(/roleName === 'super_admin'/);
    });
  });

  describe('getTransferOwner (backs requireTransferOwnership)', () => {
    it('reports the creator so the route guard can compare it', async () => {
      const id = await mkTransfer('owned-lookup', editorB);
      const owner = await transferService.getTransferOwner(id);
      expect(Number(owner.created_by)).toBe(Number(editorB));
    });

    it('returns nothing for a missing id, so the guard 404s rather than throwing', async () => {
      const owner = await transferService.getTransferOwner(999999);
      expect(owner).toBeFalsy();
    });
  });
});
