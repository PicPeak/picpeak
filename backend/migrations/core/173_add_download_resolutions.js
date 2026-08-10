/**
 * Migration 173: Download resolutions (#858).
 *
 * Two related capabilities:
 *
 *   1. STANDARD resolution — the size a gallery hands out for every ordinary
 *      download (single photo, selected, download-all). Global default in
 *      app_settings, overridable per event. 'original' keeps today's behaviour,
 *      so existing installs are unaffected until an admin changes it.
 *
 *   2. Resolution PICKER — an opt-in modal letting guests choose a different
 *      size. Off by default. Custom-resolution archives are never cached: they
 *      run through `download_jobs` (build → poll → download) so a large gallery
 *      doesn't hold an HTTP connection open for minutes.
 *
 * Per-event columns are NULLABLE on purpose: NULL = inherit the global, matching
 * the tri-state `show_watermark` / `show_qr` convention. The cached download-all
 * zip is built AT the standard resolution, so changing either the global or an
 * event override has to invalidate `events.download_zip_path` — the settings
 * write paths do that, not this migration.
 */

const PRESET_DEFAULTS = [
  { label: 'Large', width: 3000, height: 2000 },
  { label: 'Medium', width: 1500, height: 1000 },
  { label: 'Small', width: 800, height: 600 },
];

const GLOBAL_DEFAULTS = [
  // 'original' | '<width>x<height>' matching one of download_resolutions.
  ['download_standard_resolution', 'original'],
  // Master switch for the guest-facing picker.
  ['download_resolution_picker_enabled', false],
  // Whether 'Original' appears in the picker. Only consulted when the picker
  // is on — a photographer who lowers the standard usually does NOT want
  // guests helping themselves to full-res.
  ['download_allow_original', false],
  ['download_resolutions', PRESET_DEFAULTS],
];

exports.up = async function (knex) {
  if (await knex.schema.hasTable('events')) {
    const cols = [
      ['download_standard_resolution', (t) => t.string('download_standard_resolution', 32)],
      ['download_resolution_picker_enabled', (t) => t.boolean('download_resolution_picker_enabled')],
      ['download_allow_original', (t) => t.boolean('download_allow_original')],
    ];
    for (const [name, add] of cols) {
      if (!(await knex.schema.hasColumn('events', name))) {
        await knex.schema.alterTable('events', add);
      }
    }
  }

  if (!(await knex.schema.hasTable('download_jobs'))) {
    await knex.schema.createTable('download_jobs', (table) => {
      table.increments('id').primary();
      // 64 hex chars = 32 bytes. Unguessable, but never sufficient on its own —
      // the download route still runs the gallery access middleware and matches
      // the job's event_id.
      table.string('token', 64).notNullable().unique();
      table.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      // 'original' or '<width>x<height>'.
      table.string('resolution', 32).notNullable();
      // NULL = the whole visible gallery; otherwise the selected photo ids.
      // Stored as JSON text so both SQLite and PG round-trip it identically.
      table.text('photo_ids');
      // The subset that actually made it into the archive (a missing source is
      // skipped). Drives download counts; photo_ids stays the REQUESTED set so
      // the delivery fingerprint still matches.
      table.text('delivered_photo_ids');
      // Stable hash of (resolution, visibility scope, resolved photo id set,
      // watermark flag) — lets a second requester join an in-flight build
      // instead of duplicating it. The scope is part of the hash so a client
      // archive containing hidden photos can never be handed to a guest.
      table.string('dedup_key', 64).notNullable();
      // 'public' | 'hidden' — recorded alongside the hash so delivery can
      // re-check the requester still belongs to the scope the archive was
      // built for.
      table.string('visibility_scope', 16).notNullable().defaultTo('public');
      // pending | building | ready | failed
      table.string('status', 16).notNullable().defaultTo('pending');
      table.string('zip_path', 512);
      table.bigInteger('size_bytes');
      table.integer('photo_count');
      table.text('error');
      // Lease heartbeat: a live worker stamps this while building. Recovery
      // only fails rows whose heartbeat has gone stale, so a rolling restart
      // can't kill jobs another replica is still working on.
      table.timestamp('heartbeat_at');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('completed_at');
      // Swept by downloadJobCleanupService once this passes.
      table.timestamp('expires_at').notNullable();
      table.index(['event_id', 'dedup_key', 'status'], 'download_jobs_dedup_idx');
      table.index(['expires_at'], 'download_jobs_expiry_idx');
    });
  }

  if (!(await knex.schema.hasTable('app_settings'))) return;
  for (const [key, value] of GLOBAL_DEFAULTS) {
    const existing = await knex('app_settings').where('setting_key', key).first();
    if (!existing) {
      await knex('app_settings').insert({
        setting_key: key,
        // JSON-stringified so SQLite (TEXT) and Postgres (JSONB) both
        // round-trip a recognisable shape — same as migration 104.
        setting_value: JSON.stringify(value),
        setting_type: 'download',
        updated_at: new Date().toISOString(),
      });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('download_jobs');

  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings')
      .whereIn('setting_key', GLOBAL_DEFAULTS.map(([k]) => k))
      .del();
  }

  if (await knex.schema.hasTable('events')) {
    for (const name of [
      'download_standard_resolution',
      'download_resolution_picker_enabled',
      'download_allow_original',
    ]) {
      if (await knex.schema.hasColumn('events', name)) {
        await knex.schema.alterTable('events', (table) => table.dropColumn(name));
      }
    }
  }
};
