/**
 * A restored gallery's restored-from zip is recorded on its archive claim row
 * (issue 2012), in maintenance_jobs, which a .picpeak export does not carry.
 * The zip itself is exported under events/archived, so after an import
 * nothing named it and nothing ever removed it. The export now carries the
 * records in its manifest and the import writes them back, replacing the
 * target's own records: those name galleries the import replaced.
 */
const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db; let cleanup; let tmpDir; let adminId;
const job = (id) => `event_archive:${id}`;
const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

async function makeEvent(slug) {
  return unwrap(await db('events').insert({
    slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 864e5).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
    created_by: adminId, created_at: new Date().toISOString(),
  }).returning('id'));
}

async function setState(eventId, state) {
  const name = job(eventId);
  const lastResult = state ? JSON.stringify(state) : null;
  if (!(await db('maintenance_jobs').where({ job_name: name }).update({ last_result: lastResult }))) {
    await db('maintenance_jobs').insert({ job_name: name, is_running: false, last_result: lastResult });
  }
}

const stateOf = async (eventId) => {
  const row = await db('maintenance_jobs').where({ job_name: job(eventId) }).first('last_result');
  return row && row.last_result ? JSON.parse(row.last_result) : null;
};

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  ({ adminId } = await seedMinimal(db));
}, 120000);
afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(async () => {
  await db('maintenance_jobs').where('job_name', 'like', 'event_archive:%').del();
  await db('events').del();
});

describe('portable archive records', () => {
  it('exports the zips no gallery names, the superseded ones and an unpublished upload', async () => {
    const a = await makeEvent('records-a');
    const b = await makeEvent('records-b');
    await setState(a, { superseded: ['events/archived/records-a-0123456789ab.zip'], upload: 'events/archived/records-a-ba9876543210.zip' });
    // Nothing to carry: an expiry attempt only.
    await setState(b, { expiry: { attempts: 1, at: new Date().toISOString(), expiresAt: null } });

    const { exportArchiveRecords } = require('../../src/services/archiveService');
    expect(await exportArchiveRecords()).toEqual({
      [a]: ['events/archived/records-a-0123456789ab.zip', 'events/archived/records-a-ba9876543210.zip'],
    });

    const { createPicpeak } = require('../../src/services/picpeakExportService');
    const { filePath, manifest } = await createPicpeak({ includeFiles: false, outDir: path.join(tmpDir, 'records-export') });
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    expect(manifest.archive_superseded).toEqual({
      [a]: ['events/archived/records-a-0123456789ab.zip', 'events/archived/records-a-ba9876543210.zip'],
    });
  });

  it('writes the imported records back and drops the target\'s own', async () => {
    const a = await makeEvent('import-a');
    const b = await makeEvent('import-b');
    // The target's own records, for galleries the import replaced.
    await setState(b, {
      superseded: ['events/archived/target-0123456789ab.zip'],
      expiry: { attempts: 2, at: new Date().toISOString(), expiresAt: null },
    });

    const { importArchiveRecords } = require('../../src/services/archiveService');
    await db.transaction((trx) => importArchiveRecords(trx, {
      [a]: ['events/archived/import-a-0123456789ab.zip', 'events/archived/import-a-0123456789ab.zip'],
      // No such gallery in the import.
      999999: ['events/archived/gone-0123456789ab.zip'],
    }));

    expect(await stateOf(a)).toEqual({ superseded: ['events/archived/import-a-0123456789ab.zip'] });
    expect(await stateOf(b)).toBeNull();
    expect(await db('maintenance_jobs').where({ job_name: job(999999) }).first()).toBeUndefined();
    const { supersededArchives } = require('../../src/services/archiveService');
    expect(await supersededArchives(a)).toEqual(['events/archived/import-a-0123456789ab.zip']);
  });

  it('refuses keys outside events/archived from an edited archive', async () => {
    const a = await makeEvent('import-crafted');
    const { importArchiveRecords } = require('../../src/services/archiveService');
    await db.transaction((trx) => importArchiveRecords(trx, {
      [a]: [
        'events/archived/../active/import-crafted/photo.jpg',
        'events/archived//x.zip',
        'events/archived\\..\\x.zip',
        'thumbnails/x.jpg',
        42,
      ],
      '01': ['events/archived/leading-zero-0123456789ab.zip'],
      [`${a}.5`]: ['events/archived/fraction-0123456789ab.zip'],
    }));
    expect(await stateOf(a)).toBeNull();
    const rows = await db('maintenance_jobs').where('job_name', 'like', 'event_archive:%').whereNotNull('last_result');
    expect(rows).toEqual([]);
  });

  it('clears the target\'s records when the archive carries none', async () => {
    const a = await makeEvent('import-none');
    await setState(a, { superseded: ['events/archived/target-0123456789ab.zip'] });
    const { importArchiveRecords } = require('../../src/services/archiveService');
    await db.transaction((trx) => importArchiveRecords(trx, undefined));
    expect(await stateOf(a)).toBeNull();
  });
});

// The import itself runs in the supervised restore worker, Linux only.
const linux = process.platform === 'linux' ? describe : describe.skip;
linux('portable import roundtrip', () => {
  it('carries a restored gallery\'s zip record through export and import', async () => {
    const a = await makeEvent('roundtrip-a');
    const key = 'events/archived/roundtrip-a-0123456789ab.zip';
    await setState(a, { superseded: [key] });
    const { createPicpeak } = require('../../src/services/picpeakExportService');
    const { importFromPicpeak } = require('../../src/services/picpeakImportService');
    const { filePath } = await createPicpeak({ includeFiles: false, outDir: path.join(tmpDir, 'roundtrip-export') });
    await setState(a, null);

    expect((await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId })).restored).toBe(true);
    expect(await stateOf(a)).toEqual({ superseded: [key] });
  }, 120000);
});
