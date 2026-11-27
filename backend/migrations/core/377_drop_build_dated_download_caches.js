'use strict';

// Download archives built before issue 2617 date every entry by the time the
// archive was built, not by the shot time. Drop them once, as migration 347
// did: the gallery ZIP is rebuilt on the next download, and a ready download
// job expires and is swept as usual. The cached file stays at its fixed key
// until the rebuild overwrites it.
//
// Irreversible by design: there is nothing to restore.
exports.up = async function (db) {
  if (await db.schema.hasTable('events') && await db.schema.hasColumn('events', 'download_zip_path')) {
    await db('events').whereNotNull('download_zip_path')
      .update({ download_zip_path: null, download_zip_generated_at: null });
  }
  if (await db.schema.hasTable('download_jobs') && await db.schema.hasColumn('download_jobs', 'expires_at')) {
    const now = new Date().toISOString();
    await db('download_jobs').where({ status: 'ready' }).where('expires_at', '>', now)
      .update({ expires_at: now });
  }
};

exports.down = async function () {};
