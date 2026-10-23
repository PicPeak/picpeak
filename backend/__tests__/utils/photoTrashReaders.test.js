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
  'routes/adminArchives.js': [5, 'restoring an archive matches files to rows and inserts them; deleting one locks, then removes, every row and thumbnail'],
  'routes/adminCategories.js': [4, 'folder/category restructuring keeps trashed photos consistent for a restore'],
  'routes/adminDashboard.js': [1, 'storage: trashed photos still take space'],
  'routes/adminEvents/crud.js': [1, 'storage: the gallery size counts trashed photos'],
  'routes/adminEvents/helpers.js': [4, 'gallery deletion locks, then removes, every row and file, trashed ones included'],
  'routes/adminFolders.js': [2, 'folder structure is applied to trashed photos too, so a restore lands in the right folder'],
  'routes/adminImageSecurity.js': [1, 'access log listing is an audit trail and keeps the entries of trashed photos'],
  'routes/adminPhotoDimensions.js': [19, 'repair backfills (dimensions, capture date, EXIF, orientation, credits, tile placeholders) and their progress counts run over every row'],
  'routes/adminPhotos.js': [2, 'filename counter for new uploads; filenames of the photos a restore request names'],
  'routes/adminSettings.js': [2, 'storage statistics'],
  'routes/adminSystem.js': [1, 'storage statistics'],
  'routes/v1/events.js': [1, 'insert of a new photo'],
  'services/archiveService.js': [5, 'runs after purgeEventTrash; the rows must match the files that go into the zip, and every derived copy is reset'],
  'services/backgroundProcessor.js': [3, 'state of a processing run already in flight; the gallery of the photo it just processed (photo sales preview)'],
  'modules/photoSales/salesRenditions.js': [3, 'bookkeeping of a photo\'s own persisted sales preview by id (read, replace, record)'],
  'services/backupManifest.js': [1, 'backup manifest counts every row it carries'],
  'services/databaseBackup.js': [1, 'restore-time reset of every row'],
  'services/eventRenameService.js': [2, 'renaming a gallery renames the files of trashed photos too'],
  'services/externalImportService.js': [20, 'which files already belong to a photo; state of the import in flight; queues the rows it just imported for tagging; refreshes a row whose file changed by id (and records the mtime of one imported before it was; a video\'s ladder state and web copy read before and under the row lock, its poster and note fenced on the new version, and its own poster dropped when another won), and keeps a derivative any other row (trashed included) still points at'],
  'services/externalPhotoDedupe.js': [8, 'dedupe decides which row owns a file and deletes the others outright, their streaming ladders included'],
  'services/externalRelpathFold.js': [5, 'data backfill run by a migration'],
  'services/faceAutoCategories.js': [3, 'derived categorisation kept consistent for a restore'],
  'services/faceProcessor.js': [4, 'guard of a scan claim in flight, queueing (the queue skips trashed rows), purge of face data'],
  'services/faceQueue.js': [3, 'state of a claimed scan and the stuck-scan janitor; the claim itself is live only'],
  'services/feedbackIntegrity.js': [2, 'migration 309 and the portable restore: the rating dedupe recomputes the average of a photo it removed a duplicate from, and the comment_count backfill recounts every row, trashed or not'],
  'services/feedbackService.js': [5, 'row lock and per-photo counters by id, after the route checked the photo; recounts keep trashed rows consistent'],
  'services/fileWatcher.js': [9, 'which file already belongs to a photo; insert; unlink removes the row whatever its state; start-up repair gives every row on a shared thumbnail, preview or hero its own, trashed rows included'],
  'services/folderRequestService.js': [4, 'settling a folder request moves trashed photos with the rest'],
  'services/folderTreeService.js': [1, 'deleting a folder moves every photo in it to the parent'],
  'services/imageProcessor.js': [6, 'derivative of a photo in flight; whether another row shares a hero file; the size of a row handed in without it; whether a fresh tier still matches the row; whether a photo is stored under its camera name'],
  'services/mediaAttemptService.js': [11, 'attempts in flight and their recovery, restore-time reset of every row; the claim itself is live only'],
  'services/photoCap.js': [3, 'inserts of new photos'],
  'services/photoCredit.js': [7, 'guest erasure and merge treat trashed photos like any other'],
  'services/photoProcessor.js': [8, 'filename counters, inserts and the run in flight; a failed upload keeps any file a row still names, trashed or not'],
  'services/photoReplacementService.js': [6, 'writes to the replacement target found live just before; a preview or hero a trashed photo shares is kept too; a lost commit acknowledgement is detected on the row itself'],
  'services/photoService.js': [1, 'hard delete by id'],
  'services/picpeakImportService.js': [1, 'portable import: the flag travels with the row'],
  'services/portableImportMaintenance.js': [1, 'portable import: re-queues every imported row'],
  'services/publicUploadQuota.js': [2, 'guest upload quota is storage; the pending-hold reconcile names the flag on its next line'],
  'services/renditionRefresh.js': [5, 'marks a refreshed row by id; a superseded rendition another row (trashed or not) still uses is kept; waits while the upload pipeline has rows in flight; a restored rendition sets back every row naming it, trashed ones included'],
  'services/restoreService.js': [1, 'backup restore: re-queues every restored row'],
  'services/s3AutoImporter.js': [2, 'which object already belongs to a photo; insert'],
  'services/secureImageService.js': [1, 'resolves the gallery for an access-log row'],
  'services/tagProcessor.js': [3, 'guard of a tagging claim in flight; queues every photo of a gallery (the queue skips trashed rows); reset by id when the tags are dropped'],
  'services/tagQueue.js': [2, 'state of a claimed scan and the stuck-scan janitor; the claim itself is live only'],
  'services/tagSettings.js': [1, 'queues the rows an upload just finished (the queue skips trashed rows)'],
  'services/userManagementService.js': [2, 'deleting an admin clears their id on every photo'],
  'services/videoHlsQueue.js': [1, 'state of a ladder in flight'],
  'services/videoHlsService.js': [2, 'queues every video (the queue skips trashed rows); ladder in flight'],
  'services/videoRenditionQueue.js': [1, 'state of a rendition in flight'],
  'services/videoRenditionService.js': [2, 'queues every video (the queue skips trashed rows); rendition in flight'],
  'services/watermarkGeneratorService.js': [10, 'watermarks are made, renewed and cleared for trashed photos too: a restore must not serve one from old settings'],
  'routes/adminThumbnails.js': [6, 'thumbnail and preview regeneration covers trashed photos too: a restore must not bring back stale renditions; a superseded thumbnail or preview another row still uses (trashed or not) is kept'],
};

// Tables that name a photo by id keep their rows while the photo is in the
// trash, so a query on them alone still shows or counts a trashed photo's
// feedback, marks, faces, grants or transfer entries. References per file,
// reviewed as of this list: a reader either works on ids that came from a
// live-photo query, joins the live photos, or uses wherePhotoLive(). A new
// reference changes a number here; check it the same way before raising it.
const CHILD_TABLES = /\(\s*['"`](?:photo_feedback|photo_admin_marks|transfer_files|photo_faces|event_download_grants)(?: as \w+)?['"`]/g;
const CHILD_REFERENCES = {
  'routes/adminArchives.js': 3, 'routes/adminEvents/faces.js': 2, 'routes/adminEvents/helpers.js': 3,
  'routes/adminFeedback.js': 7, 'routes/adminGuests.js': 5, 'routes/adminPhotos.js': 3,
  'routes/galleryFeedback.js': 4, 'services/downloadQuota.js': 10, 'services/externalPhotoDedupe.js': 4,
  'services/faceAutoCategories.js': 1, 'services/faceClustering.js': 8, 'services/facePeopleService.js': 3,
  'services/faceProcessor.js': 7, 'services/feedbackIntegrity.js': 8,
  'services/feedbackModeration.js': 2, 'services/feedbackService.js': 40,
  'services/galleryPhotoQuery.js': 1, 'services/galleryQueryService.js': 6,
  'services/photoAdminMarksService.js': 8, 'services/picpeakImportService.js': 2,
  'services/selectionSubmissions.js': 2, 'services/transferCleanupService.js': 1, 'services/transferService.js': 12,
  'utils/anonymousFeedbackIdentity.js': 3, 'utils/photoFilterBuilder.js': 5,
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

  it('every reference to a table that names photos by id was reviewed', () => {
    const children = {};
    for (const file of sourceFiles(SRC)) {
      const count = [...fs.readFileSync(file, 'utf8').matchAll(CHILD_TABLES)].length;
      if (count > 0) children[path.relative(SRC, file).split(path.sep).join('/')] = count;
    }
    expect(children).toEqual(CHILD_REFERENCES);
  });

  it('every entry says why', () => {
    for (const [file, [, reason]] of Object.entries(ALL_ROWS)) {
      expect(`${file}: ${reason || ''}`).toMatch(/: .{10,}/);
    }
  });
});
