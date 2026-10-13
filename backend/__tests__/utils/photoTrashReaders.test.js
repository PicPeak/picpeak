/**
 * The photo trash (issue 1733, migration 294) is a flag on the photo row, so
 * every query that shows, counts or hands out photos has to leave flagged
 * rows out. Such code opens the table through utils/photoVisibility.js
 * (livePhotos, joinLivePhotos, leftJoinLivePhotos). What is left, a bare
 * reference to the `photos` table, sees trashed rows too, and is only right
 * where that is the point.
 *
 * This test counts those bare references per file and compares them with
 * the list below. A new one fails it: open the table with livePhotos(), or,
 * if the code really must see trashed photos, raise the file's number and
 * say why in its line.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');

// file: [bare references, why they see trashed rows too]
const ALL_ROWS = {
  'routes/adminArchives.js': [4, 'restoring an archive matches files to rows and inserts them; deleting one removes every row and thumbnail'],
  'routes/adminCategories.js': [4, 'folder/category restructuring keeps trashed photos consistent for a restore'],
  'routes/adminDashboard.js': [1, 'storage: trashed photos still take space'],
  'routes/adminEvents/crud.js': [1, 'storage: the gallery size counts trashed photos'],
  'routes/adminEvents/helpers.js': [3, 'gallery deletion removes every row and file, trashed ones included'],
  'routes/adminFolders.js': [2, 'folder structure is applied to trashed photos too, so a restore lands in the right folder'],
  'routes/adminImageSecurity.js': [1, 'access log listing is an audit trail and keeps the entries of trashed photos'],
  'routes/adminPhotoDimensions.js': [16, 'repair backfills (dimensions, capture date, orientation, credits) and their progress counts run over every row'],
  'routes/adminPhotos.js': [2, 'filename counter for new uploads; filenames of the photos a restore request names'],
  'routes/adminSettings.js': [2, 'storage statistics'],
  'routes/adminSystem.js': [1, 'storage statistics'],
  'routes/v1/events.js': [1, 'insert of a new photo'],
  'services/archiveService.js': [4, 'runs after purgeEventTrash; the rows must match the files that go into the zip'],
  'services/backgroundProcessor.js': [2, 'state of a processing run already in flight'],
  'services/backupManifest.js': [1, 'backup manifest counts every row it carries'],
  'services/databaseBackup.js': [1, 'restore-time reset of every row'],
  'services/eventRenameService.js': [2, 'renaming a gallery renames the files of trashed photos too'],
  'services/externalImportService.js': [6, 'which files already belong to a photo; state of the import in flight'],
  'services/externalPhotoDedupe.js': [7, 'dedupe decides which row owns a file and deletes the others outright'],
  'services/externalRelpathFold.js': [5, 'data backfill run by a migration'],
  'services/faceAutoCategories.js': [3, 'derived categorisation kept consistent for a restore'],
  'services/faceProcessor.js': [8, 'scan in flight, queueing (the queue skips trashed rows), purge of face data'],
  'services/faceQueue.js': [5, 'state of a claimed scan and the stuck-scan janitor; the claim itself is live only'],
  'services/feedbackService.js': [5, 'row lock and per-photo counters by id, after the route checked the photo; recounts keep trashed rows consistent'],
  'services/fileWatcher.js': [4, 'which file already belongs to a photo; insert; unlink removes the row whatever its state'],
  'services/folderRequestService.js': [4, 'settling a folder request moves trashed photos with the rest'],
  'services/folderTreeService.js': [1, 'deleting a folder moves every photo in it to the parent'],
  'services/imageProcessor.js': [3, 'derivative of a photo in flight; whether another row shares a hero file'],
  'services/mediaAttemptService.js': [10, 'attempts in flight and their recovery; the claim itself is live only'],
  'services/photoCap.js': [3, 'inserts of new photos'],
  'services/photoCredit.js': [7, 'guest erasure and merge treat trashed photos like any other'],
  'services/photoProcessor.js': [6, 'filename counters, inserts and the run in flight'],
  'services/photoReplacementService.js': [4, 'writes to the replacement target found live just before'],
  'services/photoService.js': [1, 'hard delete by id'],
  'services/picpeakImportService.js': [1, 'portable import: the flag travels with the row'],
  'services/portableImportMaintenance.js': [1, 'portable import: re-queues every imported row'],
  'services/publicUploadQuota.js': [2, 'guest upload quota is storage; reconciles uploads in flight'],
  'services/restoreService.js': [1, 'backup restore: re-queues every restored row'],
  'services/s3AutoImporter.js': [2, 'which object already belongs to a photo; insert'],
  'services/secureImageService.js': [1, 'resolves the gallery for an access-log row'],
  'services/userManagementService.js': [2, 'deleting an admin clears their id on every photo'],
  'services/videoRenditionQueue.js': [1, 'state of a rendition in flight'],
  'services/videoRenditionService.js': [2, 'queues every video (the queue skips trashed rows); rendition in flight'],
  'services/watermarkGeneratorService.js': [10, 'watermarks are made, renewed and cleared for trashed photos too: a restore must not serve one from old settings'],
  'routes/adminThumbnails.js': [4, 'thumbnail and preview regeneration covers trashed photos too: a restore must not bring back stale renditions'],
};

const TABLE_CALL = /(?<![\w.])(\w+)\(\s*['"`]photos(?: as \w+)?['"`]\s*[,)]/g;
const JOIN = /\.(?:join|leftJoin|innerJoin|rightJoin|from|fromRaw|table)\(\s*['"`]photos(?: as \w+)?['"`]/g;
const RAW_SQL = /\b(?:from|join|into)\s+"?photos\b|\bupdate\s+"?photos"?\s+set\b/gi;
// Schema and upload-field helpers that take the table or field name.
const NOT_A_QUERY = new Set(['hasTable', 'hasColumn', 'hasColumnCached', 'createTable', 'alterTable', 'inTable',
  'array', 'columnInfo', 'dropTableIfExists']);

function bareReferences(source) {
  let count = 0;
  for (const line of source.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    // A raw statement that names the flag itself is filtered by hand.
    if (line.includes('deleted_at')) continue;
    for (const match of line.matchAll(TABLE_CALL)) if (!NOT_A_QUERY.has(match[1])) count += 1;
    count += [...line.matchAll(JOIN)].length;
    count += [...line.matchAll(RAW_SQL)].length;
  }
  return count;
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('readers of the photos table and the photo trash', () => {
  const found = {};
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    // The helpers themselves, and the trash, which is the code that works on flagged rows.
    if (rel === 'utils/photoVisibility.js' || rel === 'services/photoTrash.js') continue;
    const count = bareReferences(fs.readFileSync(file, 'utf8'));
    if (count > 0) found[rel] = count;
  }

  it('finds the references at all', () => {
    expect(Object.keys(found).length).toBeGreaterThan(20);
    expect(bareReferences('await db(\'photos\').where({ id })')).toBe(1);
    expect(bareReferences('  .leftJoin(\'photos as p\', \'p.id\', \'x.photo_id\')')).toBe(1);
    expect(bareReferences('db.raw(`select count(*) from photos where x`)')).toBe(1);
    expect(bareReferences('await livePhotos(db).where({ id })')).toBe(0);
    expect(bareReferences('await knex.schema.hasColumn(\'photos\', \'width\')')).toBe(0);
  });

  it('every bare reference to the photos table is on the reviewed list', () => {
    const listed = Object.fromEntries(Object.entries(ALL_ROWS).filter(([, [count]]) => count > 0).map(([file, [count]]) => [file, count]));
    expect(found).toEqual(listed);
  });

  it('every entry says why', () => {
    for (const [file, [, reason]] of Object.entries(ALL_ROWS)) {
      expect(`${file}: ${reason || ''}`).toMatch(/: .{10,}/);
    }
  });
});
