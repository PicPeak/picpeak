'use strict';
const { CATALOGS, emptyFeatures } = require('./schema.cjs');
const { formatBoolean } = require('../utils/dbCompat');

const truth = (value) => value === true || value === 1 || value === '1';
const parse = (value) => {
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try { const decoded = JSON.parse(value); if (decoded === value) break; value = decoded; }
    catch { break; }
  }
  return value;
};

// Technical configuration only. Never read photos, feedback contents, guest /
// customer / admin profiles, messages, audit logs, delivery logs or counts.
// Presence queries return a literal 1, not even a row's identifying primary key.
async function expandSnapshot(db, { features, flags, used, now, version = 'usage.v2' }) {
  const result = { ...emptyFeatures(version), ...features };
  const effective = { analytics: true, userManagement: true, ...flags };
  if (!effective.quotes) effective.bills = false;
  if (effective.bills) effective.accounting = true;
  if (!effective.accounting) {
    effective.incomingInvoices = false;
    effective.expenses = false;
    effective.taxReport = false;
  }
  effective.clients = ['customerPortal', 'quotes', 'bills', 'contracts', 'projects', 'calendar', 'hoursLogging', 'newsletters']
    .some((flag) => effective[flag]);
  if (['1', 'true', 'yes'].includes(String(process.env.PICPEAK_SINGLE_CONTAINER || '').toLowerCase())) effective.faces = false;
  for (const [key, definition] of Object.entries(CATALOGS[version].features)) {
    if (definition.configuration === 'builtin') result[key].configured = true;
    if (definition.flag) result[key].configured = Boolean(effective[definition.flag]);
    if (definition.used && key !== 'custom_css') result[key].used = used.has(key);
    if (!definition.used) delete result[key].used;
  }
  // Applied custom CSS is detected locally without any visitor observation.
  result.custom_css.used = features.custom_css.used;

  const has = async (table, columns) => {
    if (!(await db.schema.hasTable(table))) return false;
    for (const column of columns) if (!(await db.schema.hasColumn(table, column))) return false;
    return true;
  };
  const exists = async (table, columns, filter) => {
    if (!(await has(table, columns))) return false;
    const query = db(table);
    filter(query);
    return Boolean(await query.select(db.raw('1 as present')).first());
  };
  const enabled = (table, column, filter = () => {}) => exists(table, [column], (query) => {
    query.where(column, formatBoolean(true)); filter(query);
  });
  const settingKeys = [
    'general_allowed_file_types', 'general_public_site_enabled',
    'download_resolution_picker_enabled', 'branding_watermark_enabled',
    'database_backup_enabled', 'backup_destination_type', 'backup_s3_bucket',
    'default_protection_level', 'enable_devtools_protection', 'enable_canvas_rendering'
  ];
  const settings = Object.fromEntries((await db('app_settings')
    .whereIn('setting_key', settingKeys).select('setting_key', 'setting_value'))
    .map((row) => [row.setting_key, parse(row.setting_value)]));
  const extensions = new Set(String(settings.general_allowed_file_types || 'jpg,jpeg,png,webp')
    .toLowerCase().split(',').map((s) => s.trim().replace(/^\./, '')));
  result.video_uploads.configured = ['mp4', 'm4v', 'webm', 'mov', 'avi'].some((extension) => extensions.has(extension));
  result.camera_raw_uploads.configured = extensions.has('dng');
  result.public_site.configured = truth(settings.general_public_site_enabled);
  result.database_backup.configured = truth(settings.database_backup_enabled);
  result.email_webhook.configured = Boolean((process.env.EMAIL_WEBHOOK_URL || '').trim() && (process.env.EMAIL_WEBHOOK_SECRET || '').trim());
  result.s3_photo_storage.configured = process.env.STORAGE_BACKEND === 's3' &&
    Boolean(process.env.STORAGE_S3_BUCKET && process.env.STORAGE_S3_ACCESS_KEY && process.env.STORAGE_S3_SECRET_KEY);
  result.s3_backups.configured = settings.backup_destination_type === 's3' && Boolean(settings.backup_s3_bucket);
  result.crm_installments.configured = Boolean(effective.quotes || effective.bills);
  result.document_templates.configured = Boolean(effective.quotes || effective.contracts);
  const imapColumns = ['imap_host', 'imap_user', 'imap_pass'];
  const imapPresent = (query) => { for (const column of imapColumns) query.whereNotNull(column).whereNot(column, ''); };
  result.incoming_mail.configured = Boolean(effective.incomingMail) && (
    await exists('email_configs', imapColumns, imapPresent) ||
    await exists('mail_accounts', [...imapColumns, 'enabled'], (query) => { imapPresent(query); query.where('enabled', formatBoolean(true)); })
  );
  result.api_integration.configured = await exists('api_tokens', ['revoked_at', 'expires_at'], (query) => {
    query.whereNull('revoked_at').where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', new Date(now).toISOString()));
  });
  result.webhooks.configured = await enabled('webhooks', 'active');
  for (const [key, column] of Object.entries({
    gallery_guest_uploads: 'allow_user_uploads',
    gallery_client_access: 'client_access_enabled', gallery_watermarks: 'watermark_downloads'
  })) result[key].configured = await enabled('events', column);
  // allow_downloads ships true — column default and the create route both set
  // it — so "at least one gallery allows downloads" is true on every install
  // with a gallery and says nothing. v2 consented to that key under that
  // description, so v2 keeps sending it unchanged. v3 asks the question that
  // is actually a decision: has anyone switched downloads off.
  if (version === 'usage.v3') {
    result.gallery_downloads_restricted.configured = await exists('events', ['allow_downloads'], (query) =>
      query.where('allow_downloads', formatBoolean(false)));
  } else {
    result.gallery_downloads.configured = await enabled('events', 'allow_downloads');
  }
  result.gallery_watermarks.configured ||= truth(settings.branding_watermark_enabled);
  result.gallery_reveal.configured = await exists('events', ['allow_user_uploads', 'reveal_mode'], (query) =>
    query.where({ allow_user_uploads: formatBoolean(true), reveal_mode: formatBoolean(true) }));
  result.gallery_expiration.configured = await exists('events', ['expires_at'], (query) => query.whereNotNull('expires_at'));
  result.download_resolution_picker.configured = truth(settings.download_resolution_picker_enabled) ||
    await enabled('events', 'download_resolution_picker_enabled');
  // Only what an operator actually changed. PicPeak ships
  // default_protection_level='standard' and enable_devtools_protection=true —
  // globally and on every event row — so accepting either as evidence made
  // this signal `true` on a bare install with no galleries at all. It reported
  // fleet-wide 100% and could never separate a deliberate configuration from
  // an untouched one, which is a field that costs consent budget and explains
  // nothing. `enable_devtools_protection` is therefore not read at all: being
  // on by default, its only informative state is off, which is the opposite
  // of what this key claims. The remaining inputs each ship off ('standard'
  // protection, no canvas rendering, right-click allowed), so a true here is
  // always a decision someone made.
  result.gallery_image_protection.configured =
    ['enhanced', 'maximum'].includes(settings.default_protection_level) ||
    truth(settings.enable_canvas_rendering);
  for (const column of ['disable_right_click', 'use_canvas_rendering'])
    result.gallery_image_protection.configured ||= await enabled('events', column);
  result.gallery_image_protection.configured ||= await exists('events', ['protection_level'], (query) =>
    query.whereIn('protection_level', ['enhanced', 'maximum']));
  for (const [suffix, column] of Object.entries({
    likes: 'allow_likes', ratings: 'allow_ratings', comments: 'allow_comments',
    favorites: 'allow_favorites', reactions: 'allow_reactions', color_labels: 'allow_color_labels'
  })) result['gallery_feedback_' + suffix].configured = await exists('event_feedback_settings', ['feedback_enabled', column], (query) =>
    query.where({ feedback_enabled: formatBoolean(true), [column]: formatBoolean(true) }));
  result.gallery_guest_accounts.configured = await exists('event_feedback_settings', ['feedback_enabled', 'identity_mode'], (query) =>
    query.where('feedback_enabled', formatBoolean(true)).whereIn('identity_mode', ['guest', 'shared']));
  if (version === 'usage.v3') {
    result.gallery_folders.configured = await exists('photo_categories', ['is_folder', 'event_id'], (query) =>
      query.where('is_folder', formatBoolean(true)).where((q) => q.whereNull('event_id').orWhereIn('event_id', db('events').select('id'))));
    result.transfer_upload_links.configured = Boolean(effective.transfers) && await exists('transfers',
      ['allow_uploads', 'deleted_at', 'upload_expires_at', 'expires_at', 'upload_token'], (query) =>
        query.where('allow_uploads', formatBoolean(true)).whereNull('deleted_at').whereNotNull('upload_token').whereNot('upload_token', '')
          .where((q) => q.where('upload_expires_at', '>', new Date(now).toISOString())
            .orWhere((fallback) => fallback.whereNull('upload_expires_at').where((expiry) =>
              expiry.whereNull('expires_at').orWhere('expires_at', '>', new Date(now).toISOString())))));
    result.workflow_automation_enabled.configured = Boolean(effective.workflows) && await enabled('workflows', 'enabled');
    result.s3_auto_import.configured = result.s3_photo_storage.configured && process.env.STORAGE_AUTO_IMPORT === 'true';
    result.crm_combined_billing.configured = Boolean(effective.bills && effective.incomingInvoices);
    result.crm_document_conversion.configured = Boolean(effective.quotes || effective.contracts);
    result.gallery_capture_date_sort.configured = await exists('events', ['default_photo_sort'], (query) =>
      query.whereIn('default_photo_sort', ['capture_date_asc', 'capture_date_desc']));
    const originalNames = await db('app_settings').where({ setting_key: 'general_use_original_filenames_for_downloads' }).first('setting_value');
    result.download_original_filenames.configured = truth(parse(originalNames?.setting_value));
  }
  return result;
}
module.exports = { expandSnapshot };
