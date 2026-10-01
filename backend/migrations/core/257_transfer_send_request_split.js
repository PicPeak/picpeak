/**
 * Migration 257: PicTransfer — split "send files" from "request files" (#1544).
 *
 * 170/171 modelled receiving as a bolt-on to sending: one `transfers` row was a
 * send (gallery photos + admin extras behind a 64-hex token) that could
 * optionally flip on `allow_uploads` and hand out a short upload code. That made
 * "just collect files from a client" an awkward send with no files, a dead
 * download link and a download-page message nobody reads.
 *
 * This makes the two first-class and mutually exclusive:
 *
 *   kind = 'send'     Files go OUT. `token` is the recipient download link.
 *                     Never accepts uploads.
 *   kind = 'request'  Files come IN. `token` is the (64-hex) upload link and
 *                     `expires_at` is the single upload deadline; the short
 *                     `upload_token` survives as an optional read-aloud code.
 *                     Never serves a download.
 *
 * Existing rows that did BOTH (photos/extras *and* allow_uploads) are split into
 * two rows rather than having one half dropped: the original keeps the photos
 * and its download token, a new request row takes the upload token, the upload
 * deadline and the `transfer_uploads` already received. Both links a client may
 * already be holding keep working.
 *
 * Also lands the settings + templates the split needs:
 *   - `transfer_upload_allowed_types` ({mime, extensions[]} list) and
 *     `transfer_upload_accept_all`, migrated from `transfer_upload_allowed_mime`.
 *     The old key is left in place; the service reads it as a fallback.
 *   - `transfer_request` (to the client: "please upload") and
 *     `transfer_files_received` (to the admin: "N files arrived").
 *
 * Note on the split rows' bytes: a moved `transfer_uploads.stored_path` still
 * points under the OLD transfer's `uploads/transfers/<oldId>/` directory. The
 * per-file deletes work off `stored_path` and are unaffected, and
 * transferService.removeUploadedFiles asks whether any OTHER transfer still
 * references a path under the prefix before removing the directory — none does
 * → recursive delete, orphan bytes included; one does → the directory is left
 * alone. So deleting the send cannot take the request's received files with it,
 * and a file written before its DB row failed is still cleaned up.
 */

const crypto = require('crypto');

const { formatBoolean } = require('../../src/utils/dbCompat');

const DEFAULT_ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/tiff', 'application/pdf', 'application/zip',
];

// Types that are the same thing under two names. An allowlist naming one must
// name the other, or the file is refused on whichever platform sends the
// spelling that was left out. Extension matching covers the common case on its
// own, but a file with no extension has only its MIME to go on.
const MIME_ALIASES = {
  'application/zip': ['application/x-zip-compressed'],
  'application/x-zip-compressed': ['application/zip'],
};

// Extensions for the types 170 seeded, plus the ones admins most often add by
// hand. `image/tiff` and `application/zip` were seeded as allowed but had no
// entry in fileSecurityUtils' registry, so validateFileType rejected them —
// carrying explicit extensions here is what finally makes them work.
const MIME_EXTENSIONS = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/tiff': ['.tif', '.tiff'],
  'image/svg+xml': ['.svg'],
  'image/heic': ['.heic'],
  'image/heif': ['.heif'],
  'image/x-adobe-dng': ['.dng'],
  'application/pdf': ['.pdf'],
  'application/zip': ['.zip'],
  // What Chrome and Firefox on Windows actually send for a .zip.
  'application/x-zip-compressed': ['.zip'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
  'video/x-msvideo': ['.avi'],
};

/** Best-effort extension list for a MIME an admin added by hand. */
function extensionsFor(mime) {
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  // `application/vnd.…-officedocument.wordprocessingml.document` → no guess.
  // Leave it empty: the validator treats an empty list as "extension not
  // checked for this type", which is the only honest reading of a hand-added
  // MIME we have no registry entry for.
  return [];
}

function parseSettingValue(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

/**
 * The two templates this migration seeds. Declared once so `down()` can compare
 * a live row against what was actually written here — see `seededBodyFor`.
 */
const SEEDED_TEMPLATES = [
  {
    template_key: 'transfer_request',
    subject_en: 'Please upload your files — {{transfer_title}}',
    subject_de: 'Bitte laden Sie Ihre Dateien hoch — {{transfer_title}}',
    body_html_en: `
<h2>Please upload your files</h2>

<p>{{transfer_title}}</p>

{{#if message}}<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;">{{message}}</p>
</div>{{/if}}

<p style="margin: 24px 0;">
  <a href="{{upload_url}}" class="button">Upload your files</a>
</p>

<p><strong>Please upload by:</strong> {{expiry_date}}</p>

<p style="color: #888; font-size: 13px;">If the button doesn't work, copy this link into your browser:<br>{{upload_url}}</p>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
    body_text_en: `Please upload your files

{{transfer_title}}
{{#if message}}
{{message}}
{{/if}}
Upload your files: {{upload_url}}

Please upload by: {{expiry_date}}

Best regards,
Your PicPeak Installation`,
    body_html_de: `
<h2>Bitte laden Sie Ihre Dateien hoch</h2>

<p>{{transfer_title}}</p>

{{#if message}}<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;">{{message}}</p>
</div>{{/if}}

<p style="margin: 24px 0;">
  <a href="{{upload_url}}" class="button">Dateien hochladen</a>
</p>

<p><strong>Bitte hochladen bis:</strong> {{expiry_date}}</p>

<p style="color: #888; font-size: 13px;">Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:<br>{{upload_url}}</p>

<p>Mit freundlichen Grüßen,<br>
Ihre PicPeak-Installation</p>`,
    body_text_de: `Bitte laden Sie Ihre Dateien hoch

{{transfer_title}}
{{#if message}}
{{message}}
{{/if}}
Dateien hochladen: {{upload_url}}

Bitte hochladen bis: {{expiry_date}}

Mit freundlichen Grüßen,
Ihre PicPeak-Installation`,
    variables: JSON.stringify(['transfer_title', 'message', 'upload_url', 'upload_code', 'expiry_date']),
  },

  {
    template_key: 'transfer_files_received',
    subject_en: 'Files received — {{transfer_title}}',
    subject_de: 'Dateien erhalten — {{transfer_title}}',
    body_html_en: `
<h2>Files received</h2>

<p>{{file_count}} file(s) were uploaded to <strong>{{transfer_title}}</strong>.</p>

<p><strong>Received:</strong> {{received_at}}<br>
<strong>Files in this request so far:</strong> {{total_count}}</p>

<p style="margin: 24px 0;">
  <a href="{{admin_url}}" class="button">Open in PicPeak</a>
</p>

<p style="color: #888; font-size: 13px;">Uploaded files are stored as-is and are never opened or processed by PicPeak. Scan them before you use them.</p>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
    body_text_en: `Files received

{{file_count}} file(s) were uploaded to {{transfer_title}}.

Received: {{received_at}}
Files in this request so far: {{total_count}}

Open in PicPeak: {{admin_url}}

Uploaded files are stored as-is and are never opened or processed by PicPeak. Scan them before you use them.

Best regards,
Your PicPeak Installation`,
    body_html_de: `
<h2>Dateien erhalten</h2>

<p>{{file_count}} Datei(en) wurden zu <strong>{{transfer_title}}</strong> hochgeladen.</p>

<p><strong>Erhalten:</strong> {{received_at}}<br>
<strong>Dateien in dieser Anfrage bisher:</strong> {{total_count}}</p>

<p style="margin: 24px 0;">
  <a href="{{admin_url}}" class="button">In PicPeak öffnen</a>
</p>

<p style="color: #888; font-size: 13px;">Hochgeladene Dateien werden unverändert gespeichert und von PicPeak nie geöffnet oder verarbeitet. Prüfen Sie sie, bevor Sie sie verwenden.</p>

<p>Mit freundlichen Grüßen,<br>
Ihre PicPeak-Installation</p>`,
    body_text_de: `Dateien erhalten

{{file_count}} Datei(en) wurden zu {{transfer_title}} hochgeladen.

Erhalten: {{received_at}}
Dateien in dieser Anfrage bisher: {{total_count}}

In PicPeak öffnen: {{admin_url}}

Hochgeladene Dateien werden unverändert gespeichert und von PicPeak nie geöffnet oder verarbeitet. Prüfen Sie sie, bevor Sie sie verwenden.

Mit freundlichen Grüßen,
Ihre PicPeak-Installation`,
    variables: JSON.stringify(['transfer_title', 'file_count', 'total_count', 'received_at', 'admin_url']),
  },
];

const SEEDED_TEMPLATE_BODIES = Object.fromEntries(
  SEEDED_TEMPLATES.map((tpl) => [tpl.template_key, tpl.body_html_en]),
);

exports.up = async function (knex) {
  // ---------------------------------------------------------------- kind
  if (!(await knex.schema.hasColumn('transfers', 'kind'))) {
    await knex.schema.alterTable('transfers', (table) => {
      // 'send' | 'request'. Defaulting to 'send' makes every pre-existing row
      // a send until the backfill below reclassifies the upload-only ones.
      table.string('kind', 10).notNullable().defaultTo('send');
    });
    await knex.schema.alterTable('transfers', (table) => {
      table.index(['kind'], 'transfers_kind_idx');
    });
  }

  // A request's "files received" notice is rate-limited on this stamp. The
  // upload endpoint is unauthenticated and rate-limited per /64 only, so
  // without a cooldown anyone holding a request link could drive hundreds of
  // mails an hour into the creator's inbox. Separate from admin_notified_at,
  // which the expiry sweep owns.
  if (!(await knex.schema.hasColumn('transfers', 'uploads_notified_at'))) {
    await knex.schema.alterTable('transfers', (table) => {
      table.timestamp('uploads_notified_at');
    });
  }

  // ------------------------------------------------------------- backfill
  // A row needs reclassifying if it can still RECEIVE (allow_uploads) or if it
  // already HAS received something. The second half matters: pre-257
  // `disableUploads` cleared allow_uploads and the short code but left
  // `transfer_uploads` in place, so an instance can hold sends carrying a
  // client's files. Those rows are invisible under a strict split — the detail
  // panel shows received files only on a request — and the retention sweep
  // would hard-delete files nobody could reach. Everything else already has
  // the column default.
  const receivedIn = (await knex('transfer_uploads').distinct('transfer_id').select('transfer_id'))
    .map((r) => r.transfer_id);
  const rows = await knex('transfers')
    .whereNull('deleted_at')
    .where((q) => {
      q.whereIn('allow_uploads', [true, 1]);
      if (receivedIn.length) q.orWhereIn('id', receivedIn);
    })
    .select('*');
  const candidateIds = rows.map((r) => r.id);

  const countsFor = async (table) => {
    if (!candidateIds.length) return new Map();
    const grouped = await knex(table)
      .whereIn('transfer_id', candidateIds)
      .select('transfer_id')
      .count('* as c')
      .groupBy('transfer_id');
    return new Map(grouped.map((g) => [g.transfer_id, Number(g.c) || 0]));
  };
  const photoCounts = await countsFor('transfer_files');
  const extraCounts = await countsFor('transfer_extra_files');

  for (const row of rows) {
    const hasOutbound = (photoCounts.get(row.id) || 0) + (extraCounts.get(row.id) || 0) > 0;

    // The upload deadline becomes the request's single `expires_at`.
    const uploadDeadline = row.upload_expires_at || row.expires_at;

    if (!hasOutbound) {
      // Nothing goes out: convert in place.
      //
      // A FRESH token, not the existing one. That value was handed out as a
      // download link, and post-257 the same column is the upload link — so
      // reusing it would let anyone who was ever sent the old (dead) download
      // link upload into this request. The short code is unaffected and keeps
      // working, which is what a client in the middle of a job actually holds.
      await knex('transfers').where({ id: row.id }).update({
        kind: 'request',
        token: await uniqueDownloadToken(knex),
        expires_at: uploadDeadline,
        upload_expires_at: null,
        max_downloads: null,
        updated_at: new Date(),
      });
      continue;
    }

    // Did both: keep the send, spin the receiving half out into its own row.
    //
    // All three statements run in ONE transaction. run-migrations.js wraps a
    // migration in a transaction on PostgreSQL only, so on SQLite a crash
    // between the send's update and the request's insert would lose the
    // receiving half for good: the send is no longer a candidate on re-run
    // (allow_uploads cleared), the short code is gone, and the uploads sit on
    // a kind='send' row. A migration that moves rows should not have that
    // window, however narrow.
    const shortCode = row.upload_token || null;
    await knex.transaction(async (trx) => {
      // The send releases the short code FIRST. `upload_token` carries a
      // UNIQUE constraint, so inserting the request row while the send still
      // holds the same value would fail.
      await trx('transfers').where({ id: row.id }).update({
        kind: 'send',
        allow_uploads: formatBoolean(false),
        upload_token: null,
        upload_expires_at: null,
        updated_at: new Date(),
      });

      const newToken = await uniqueDownloadToken(trx);
      const inserted = await trx('transfers').insert({
        token: newToken,
        title: row.title || '',
        message: row.message || null,
        created_by: row.created_by || null,
        kind: 'request',
        expires_at: uploadDeadline,
        max_downloads: null,
        download_count: 0,
        is_active: row.is_active,
        disabled_at: row.disabled_at || null,
        // Carried, not reset: transferCleanupService notifies on
        // (inactive AND disabled_at AND admin_notified_at IS NULL), so a null
        // here would send a SECOND expiry mail for a transfer the admin was
        // already told about — worded for a send, reporting zero files.
        admin_notified_at: row.admin_notified_at || null,
        grace_days: row.grace_days,
        allow_uploads: formatBoolean(true),
        upload_token: shortCode,
        upload_expires_at: null,
        delivery_method: row.delivery_method || 'link',
        created_at: row.created_at || new Date(),
        updated_at: new Date(),
      }).returning('id');
      const newId = typeof inserted[0] === 'object' && inserted[0] !== null
        ? inserted[0].id
        : inserted[0];

      // Received files follow the request. Their stored_path still points
      // under the old transfer's directory — see the header note.
      await trx('transfer_uploads').where('transfer_id', row.id).update({ transfer_id: newId });
    });
  }

  // ------------------------------------------------------------- settings
  const legacyRow = await knex('app_settings')
    .where('setting_key', 'transfer_upload_allowed_mime')
    .first();
  const legacyList = parseSettingValue(legacyRow && legacyRow.setting_value, DEFAULT_ALLOWED_MIME);
  const mimes = Array.isArray(legacyList) && legacyList.length ? legacyList : DEFAULT_ALLOWED_MIME;

  // Carry the legacy list over, and add each entry's aliases. Migration 170
  // seeded `application/zip` only, so without this every upgrading instance —
  // which is all of them — would still refuse a ZIP sent from Windows under
  // its other name.
  const wanted = new Set(mimes.map((m) => String(m || '').trim().toLowerCase()).filter(Boolean));
  for (const mime of [...wanted]) {
    for (const alias of MIME_ALIASES[mime] || []) wanted.add(alias);
  }
  const allowedTypes = [...wanted].map((mime) => ({ mime, extensions: extensionsFor(mime) }));

  const newSettings = [
    {
      setting_key: 'transfer_upload_allowed_types',
      setting_value: JSON.stringify(allowedTypes),
      setting_type: 'general',
    },
    {
      setting_key: 'transfer_upload_accept_all',
      setting_value: JSON.stringify(false),
      setting_type: 'boolean',
    },
  ];
  for (const s of newSettings) {
    const exists = await knex('app_settings').where('setting_key', s.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({ ...s, updated_at: knex.fn.now() });
    }
  }

  // ------------------------------------------------------------ templates
  for (const tpl of SEEDED_TEMPLATES) {
    await insertTemplate(knex, tpl);
  }
};

async function uniqueDownloadToken(knex) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = crypto.randomBytes(32).toString('hex');
    const clash = await knex('transfers').where({ token: candidate }).first('id');
    if (!clash) return candidate;
  }
  // 256 bits: reaching here means something other than chance is wrong, but a
  // migration must not loop forever.
  return crypto.randomBytes(32).toString('hex');
}

async function insertTemplate(knex, template) {
  const existing = await knex('email_templates').where('template_key', template.template_key).first();
  if (existing) return;
  await knex('email_templates').insert(template);
}

/**
 * The seeded body for a template key, so `down()` can tell a row this
 * migration created from one an admin has since edited (or one that already
 * existed and was left alone by `insertTemplate`).
 */
function seededBodyFor(key) {
  return SEEDED_TEMPLATE_BODIES[key] || null;
}

exports.down = async function (knex) {
  // Only remove a template that still looks exactly as this migration seeded
  // it. `insertTemplate` skips a key that already existed, and an admin may
  // have edited the wording since — an unconditional delete would destroy
  // either one on a rollback.
  for (const key of ['transfer_request', 'transfer_files_received']) {
    const row = await knex('email_templates').where('template_key', key).first();
    if (!row) continue;
    const seeded = seededBodyFor(key);
    if (seeded && row.body_html_en === seeded) {
      await knex('email_templates').where('template_key', key).del();
    }
  }
  await knex('app_settings')
    .whereIn('setting_key', ['transfer_upload_allowed_types', 'transfer_upload_accept_all'])
    .del();
  // The row split is not reversed: merging a request back into the send it came
  // from would have to guess which send, and the request rows are legitimate
  // records of files a client actually sent. Dropping `kind` just makes every
  // row a transfer again, which is what the pre-257 code expects.
  if (await knex.schema.hasColumn('transfers', 'uploads_notified_at')) {
    await knex.schema.alterTable('transfers', (table) => {
      table.dropColumn('uploads_notified_at');
    });
  }
  if (await knex.schema.hasColumn('transfers', 'kind')) {
    await knex.schema.alterTable('transfers', (table) => {
      table.dropIndex(['kind'], 'transfers_kind_idx');
    });
    await knex.schema.alterTable('transfers', (table) => {
      table.dropColumn('kind');
    });
  }
};
