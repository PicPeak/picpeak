'use strict';

// Download archives built before issue 2617 date every entry by the time the
// archive was built, not by the shot time. Drop the cached gallery ZIP once,
// as migration 347 did, so it is rebuilt on the next download. The cached
// file stays at its fixed key until the rebuild overwrites it. Ready download
// jobs are left alone: their links may already be in a guest's inbox, and
// they expire soon anyway.
//
// Irreversible by design: there is nothing to restore.
exports.up = async function (db) {
  if (await db.schema.hasTable('events') && await db.schema.hasColumn('events', 'download_zip_path')) {
    await db('events').whereNotNull('download_zip_path')
      .update({ download_zip_path: null, download_zip_generated_at: null });
  }
};

exports.down = async function () {};
