/**
 * Report accuracy (#1110).
 *
 * Two signals were wrong in ways that only show up in the aggregate, where
 * nobody can tell the number is wrong: preset-themed installs all reported
 * `grid`, and CSS applied through a template reported no custom CSS at all.
 *
 * Also covers status() surviving a misconfigured collector URL — it used to
 * throw, which took down the settings tab that is the only way to withdraw.
 */
const knex = require('knex');
const { UsageService } = require('../../src/usage/UsageService');
const { featureKeysFor, CATALOGS, generateIdentity, makePacket, signPacket, verifyEnvelope } = require('../../src/usage/protocol.cjs');
const FEATURE_KEYS = featureKeysFor('usage.v2');
const CATALOG = CATALOGS['usage.v2'];

async function bootDb() {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.schema.createTable('product_usage_state', (t) => {
    t.integer('id').primary();
    t.string('status', 30).notNullable().defaultTo('disabled');
    t.string('consent_version', 40).notNullable().defaultTo('usage-consent.v1');
    t.boolean('notice_dismissed').notNullable().defaultTo(false);
    t.string('installation_id', 64);
    t.string('public_key', 59);
    t.text('private_key_encrypted');
    t.string('instance_binding', 64);
    t.bigInteger('sequence').notNullable().defaultTo(0);
    t.text('pending_packet'); t.text('last_packet'); t.text('last_receipt');
    t.text('privacy_receipts');
    t.string('last_report_date', 10); t.string('last_error', 80);
    t.text('feedback_preferences'); t.string('lease_token', 36);
    t.bigInteger('lease_until').notNullable().defaultTo(0);
    t.bigInteger('cancel_seq').notNullable().defaultTo(0);
    t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('next_attempt_at').notNullable().defaultTo(0);
  });
  await db('product_usage_state').insert({ id: 1 });
  await db.schema.createTable('product_usage_markers', (t) => t.string('feature', 60).primary());
  await db.schema.createTable('app_settings', (t) => {
    t.string('setting_key').primary(); t.text('setting_value'); t.string('setting_type');
  });
  await db.schema.createTable('feature_flags', (t) => {
    t.string('key').primary(); t.boolean('value');
  });
  await db.schema.createTable('events', (t) => {
    t.increments('id'); t.text('color_theme'); t.string('external_path');
    t.integer('css_template_id');
  });
  await db.schema.createTable('css_templates', (t) => {
    t.increments('id'); t.boolean('is_enabled'); t.text('css_content');
  });
  for (const table of ['email_configs', 'mail_accounts']) {
    await db.schema.createTable(table, (t) => { t.increments('id'); t.string('smtp_host'); });
  }
  await db.schema.createTable('whatsapp_configs', (t) => {
    t.increments('id'); t.boolean('enabled'); t.string('phone_number_id'); t.string('access_token');
  });
  return db;
}

const service = (db, over = {}) =>
  new UsageService(db, { secret: 'q'.repeat(48), ...over });

describe('gallery_layouts resolves what the gallery actually renders', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  it('maps preset NAMES to their layouts instead of calling them all grid', async () => {
    db = await bootDb();
    await db('events').insert([
      { color_theme: 'modernMasonry' },
      { color_theme: 'corporateTimeline' },
      { color_theme: 'galleryStory' },
    ]);
    const report = await service(db).snapshot();
    expect(report.gallery_layouts.sort()).toEqual(
      ['gallery-story', 'masonry', 'timeline'].sort()
    );
  });

  it('still reads a theme object', async () => {
    db = await bootDb();
    await db('events').insert([{ color_theme: JSON.stringify({ galleryLayout: 'mosaic' }) }]);
    expect((await service(db).snapshot()).gallery_layouts).toEqual(['mosaic']);
  });

  it('reports an unknown preset as other, not as grid', async () => {
    // A preset added on the frontend must not silently inflate the grid count.
    db = await bootDb();
    await db('events').insert([{ color_theme: 'somePresetAddedLater' }]);
    expect((await service(db).snapshot()).gallery_layouts).toEqual(['other']);
  });

  it('uses the global theme for an event that has none of its own', async () => {
    db = await bootDb();
    await db('app_settings').insert({
      setting_key: 'theme_config',
      setting_value: JSON.stringify({ galleryLayout: 'carousel' }),
    });
    await db('events').insert([{ color_theme: null }]);
    expect((await service(db).snapshot()).gallery_layouts).toEqual(['carousel']);
  });
});

describe('custom_css counts CSS applied through a template', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  it('is configured when an enabled template is applied to an event', async () => {
    db = await bootDb();
    const [id] = await db('css_templates').insert({ is_enabled: true, css_content: '.a{}' });
    await db('events').insert([{ color_theme: null, css_template_id: id }]);
    expect((await service(db).snapshot()).features.custom_css.configured).toBe(true);
  });

  it('is not configured when the applied template is disabled', async () => {
    db = await bootDb();
    const [id] = await db('css_templates').insert({ is_enabled: false, css_content: '.a{}' });
    await db('events').insert([{ color_theme: null, css_template_id: id }]);
    expect((await service(db).snapshot()).features.custom_css.configured).toBe(false);
  });

  it('is not configured when an enabled template is applied to nothing', async () => {
    db = await bootDb();
    await db('css_templates').insert({ is_enabled: true, css_content: '.a{}' });
    await db('events').insert([{ color_theme: null }]);
    expect((await service(db).snapshot()).features.custom_css.configured).toBe(false);
  });
});

describe('status survives a misconfigured collector URL', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  it.each([
    ['a bare hostname', 'usage.picpeak.app'],
    ['a URL with a path', 'https://usage.picpeak.app/collect'],
    ['a URL with a query', 'https://usage.picpeak.app/?x=1'],
  ])('reports %s as a configuration error rather than failing the request', async (_l, endpoint) => {
    db = await bootDb();
    const status = await service(db, { endpoint }).status();
    expect(status.collector_error).toBe('INVALID_COLLECTOR_URL');
    expect(status.collector_url).toBeNull();
    // The operator can still read their state — and therefore still withdraw.
    expect(status.status).toBe('disabled');
  });

  it('reports no error for a valid collector', async () => {
    db = await bootDb();
    const status = await service(db, { endpoint: 'https://usage.picpeak.app' }).status();
    expect(status.collector_error).toBeNull();
    expect(status.collector_url).toBe('https://usage.picpeak.app');
  });
});

describe('S3 use is only implied by backups that write to the destination', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  const withS3Destination = async (database) => {
    await database('app_settings').insert({
      setting_key: 'backup_destination_type',
      setting_value: JSON.stringify('s3'),
    });
    await database('product_usage_state').where({ id: 1 }).update({ status: 'active' });
  };

  it('marks S3 for a backup that uses the configured destination', async () => {
    db = await bootDb();
    await withS3Destination(db);
    await service(db).markUsed(['backup'], { destinationBackup: true });
    expect((await db('product_usage_markers').pluck('feature')).sort())
      .toEqual(['backup', 's3_storage']);
  });

  it('does NOT mark S3 for a local backup, even with S3 configured', async () => {
    // /database-backup/* and /backup/picpeak/export produce a local file. They
    // count as `backup`, but claiming S3 was used for them made merely
    // configuring S3 and downloading an export report s3_storage.used.
    db = await bootDb();
    await withS3Destination(db);
    await service(db).markUsed(['backup']);
    expect(await db('product_usage_markers').pluck('feature')).toEqual(['backup']);
  });

  it('does not mark S3 when the destination is not S3', async () => {
    db = await bootDb();
    await db('app_settings').insert({
      setting_key: 'backup_destination_type',
      setting_value: JSON.stringify('local'),
    });
    await db('product_usage_state').where({ id: 1 }).update({ status: 'active' });
    await service(db).markUsed(['backup'], { destinationBackup: true });
    expect(await db('product_usage_markers').pluck('feature')).toEqual(['backup']);
  });
});

/**
 * A signal whose answer is fixed by the shipped defaults is not a signal.
 * PicPeak ships default_protection_level='standard' and
 * enable_devtools_protection=true, so accepting either as evidence made
 * gallery_image_protection true on a bare install with no galleries — a
 * fleet-wide 100% that cannot separate a decision from an untouched default.
 */
describe('gallery_image_protection reports decisions, not shipped defaults', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  const v2 = async () => {
    db = await bootDb();
    await db.schema.alterTable('events', (t) => {
      for (const column of ['disable_right_click', 'enable_devtools_protection', 'use_canvas_rendering']) t.boolean(column);
      t.string('protection_level');
    });
    await db('product_usage_state').where({ id: 1 })
      .update({ status: 'active', consent_version: 'usage-consent.v2' });
    return service(db);
  };
  const shipped = async () => {
    // Exactly what migration 038 seeds, plus an event carrying the column
    // defaults from the same migration.
    await db('app_settings').insert([
      { setting_key: 'default_protection_level', setting_value: '"standard"' },
      { setting_key: 'enable_devtools_protection', setting_value: 'true' },
      { setting_key: 'enable_canvas_rendering', setting_value: 'false' },
    ]);
    await db('events').insert({
      protection_level: 'standard',
      enable_devtools_protection: true,
      use_canvas_rendering: false,
      disable_right_click: false,
    });
  };

  it('is false on a bare install with no galleries at all', async () => {
    const client = await v2();
    expect((await client.snapshot()).features.gallery_image_protection)
      .toEqual({ configured: false });
  });

  it('is false when every value is still the shipped default', async () => {
    const client = await v2();
    await shipped();
    expect((await client.snapshot()).features.gallery_image_protection)
      .toEqual({ configured: false });
  });

  it('ignores the devtools flag entirely, since it ships on', async () => {
    const client = await v2();
    await shipped();
    // Turning it OFF is the only informative state it has, and that is the
    // opposite of what this key claims — so neither state may set it.
    await db('app_settings').where({ setting_key: 'enable_devtools_protection' })
      .update({ setting_value: 'false' });
    await db('events').update({ enable_devtools_protection: false });
    expect((await client.snapshot()).features.gallery_image_protection)
      .toEqual({ configured: false });
  });

  it.each([
    ['a stronger global level', async (db) => db('app_settings').where({ setting_key: 'default_protection_level' }).update({ setting_value: '"maximum"' })],
    ['global canvas rendering', async (db) => db('app_settings').where({ setting_key: 'enable_canvas_rendering' }).update({ setting_value: 'true' })],
    ['a stronger level on one gallery', async (db) => db('events').update({ protection_level: 'enhanced' })],
    ['canvas rendering on one gallery', async (db) => db('events').update({ use_canvas_rendering: true })],
    ['right-click disabled on one gallery', async (db) => db('events').update({ disable_right_click: true })],
  ])('is true for %s', async (_label, change) => {
    const client = await v2();
    await shipped();
    await change(db);
    expect((await client.snapshot()).features.gallery_image_protection)
      .toEqual({ configured: true });
  });
});

/**
 * The settings preview is the "see exactly what would be sent" view. It shared
 * snapshot() with the real sender, and snapshot() records applied custom CSS
 * as a lifetime marker — so reading the transparency view wrote a marker.
 */
describe('preview does not change what will be sent', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  const withAppliedCss = async () => {
    db = await bootDb();
    await db('product_usage_state').where({ id: 1 })
      .update({ status: 'active', consent_version: 'usage-consent.v2' });
    await db('app_settings').insert({
      setting_key: 'general_custom_css', setting_value: '".x{}"'
    });
    return service(db);
  };

  it('reports custom_css as used without persisting the marker', async () => {
    const client = await withAppliedCss();
    const preview = await client.preview();
    expect(preview.features.custom_css).toEqual({ configured: true, used: true });
    expect(await db('product_usage_markers').pluck('feature')).toEqual([]);
  });

  it('still persists it when the sender builds the real report', async () => {
    const client = await withAppliedCss();
    await client.snapshot();
    expect(await db('product_usage_markers').pluck('feature')).toEqual(['custom_css']);
  });
});

describe('v2 technical configuration and privacy boundaries', () => {
  let db;
  let savedEnv;
  beforeEach(() => { savedEnv = { ...process.env }; });
  afterEach(async () => { if (db) await db.destroy(); db = null; process.env = savedEnv; });
  async function expandedDb() {
    db = await bootDb();
    await db('product_usage_state').where({ id: 1 }).update({ status: 'active', consent_version: 'usage-consent.v2' });
    await db.schema.alterTable('events', (t) => {
      for (const column of ['allow_user_uploads', 'allow_downloads', 'client_access_enabled', 'watermark_downloads', 'reveal_mode', 'download_resolution_picker_enabled', 'disable_right_click', 'enable_devtools_protection', 'use_canvas_rendering']) t.boolean(column);
      t.string('protection_level'); t.timestamp('expires_at'); t.string('event_name'); t.string('customer_email');
    });
    for (const table of ['email_configs', 'mail_accounts']) await db.schema.alterTable(table, (t) => {
      t.boolean('enabled'); t.string('imap_host'); t.string('imap_user'); t.string('imap_pass');
    });
    await db.schema.createTable('event_feedback_settings', (t) => {
      t.increments('id'); t.boolean('feedback_enabled'); t.string('identity_mode');
      for (const col of ['allow_likes', 'allow_ratings', 'allow_comments', 'allow_favorites', 'allow_reactions', 'allow_color_labels']) t.boolean(col);
    });
    await db.schema.createTable('api_tokens', (t) => { t.increments('id'); t.timestamp('revoked_at'); t.timestamp('expires_at'); t.string('token_hash'); });
    await db.schema.createTable('webhooks', (t) => { t.increments('id'); t.boolean('active'); t.string('url'); t.string('secret'); });
    return service(db, { now: () => Date.parse('2026-09-06T12:00:00.000Z'), version: '3.124.1-beta.0' });
  }

  it('produces all 73 closed booleans, never exposing sensitive values or configuration-only used', async () => {
    const client = await expandedDb();
    const flags = [...new Set(Object.values(CATALOG.features).map((f) => f.flag).filter(Boolean)), 'incomingMail', 'whatsapp'];
    await db('feature_flags').insert([...new Set(flags)].map((key) => ({ key, value: true })));
    const settings = {
      general_allowed_file_types: 'jpg,dng,mp4', general_public_site_enabled: true,
      database_backup_enabled: true, backup_destination_type: 's3', backup_s3_bucket: 'PRIVATE-bucket',
      oidc_enabled: true, oidc_issuer_url: 'https://PRIVATE.example.test', oidc_client_id: 'PRIVATE-client',
      general_custom_css: '.PRIVATE { color:red; }'
    };
    await db('app_settings').insert(Object.entries(settings).map(([setting_key, value]) => ({ setting_key, setting_value: JSON.stringify(value) })));
    await db('events').insert({
      event_name: 'PRIVATE PERSON', customer_email: 'PRIVATE@example.test', external_path: '/PRIVATE/path',
      color_theme: JSON.stringify({ galleryLayout: 'gallery-story', privateName: 'PRIVATE' }),
      allow_user_uploads: true, allow_downloads: true, client_access_enabled: true, watermark_downloads: true,
      reveal_mode: true, download_resolution_picker_enabled: true, disable_right_click: true,
      expires_at: '2028-01-01T00:00:00.000Z'
    });
    await db('event_feedback_settings').insert({ feedback_enabled: true, identity_mode: 'guest',
      allow_likes: true, allow_ratings: true, allow_comments: true, allow_favorites: true, allow_reactions: true, allow_color_labels: true });
    await db('email_configs').insert({ smtp_host: 'PRIVATE-host', imap_host: 'PRIVATE-host', imap_user: 'PRIVATE-user', imap_pass: 'PRIVATE-secret' });
    await db('whatsapp_configs').insert({ enabled: true, phone_number_id: 'PRIVATE-phone', access_token: 'PRIVATE-token' });
    await db('api_tokens').insert({ token_hash: 'PRIVATE-token', expires_at: '2028-01-01T00:00:00.000Z' });
    await db('webhooks').insert({ active: true, url: 'https://PRIVATE.example.test', secret: 'PRIVATE-secret' });
    Object.assign(process.env, { STORAGE_BACKEND: 's3', STORAGE_S3_BUCKET: 'PRIVATE', STORAGE_S3_ACCESS_KEY: 'PRIVATE', STORAGE_S3_SECRET_KEY: 'PRIVATE', EMAIL_WEBHOOK_URL: 'https://PRIVATE.example.test', EMAIL_WEBHOOK_SECRET: 'PRIVATE' });
    delete process.env.PICPEAK_SINGLE_CONTAINER;
    await client.markUsed([...FEATURE_KEYS, 'PRIVATE@example.test']);
    const report = await client.snapshot();
    expect(Object.keys(report.features)).toEqual(FEATURE_KEYS);
    for (const [key, definition] of Object.entries(CATALOG.features)) {
      expect(report.features[key].configured).toBe(true);
      if (definition.used) expect(report.features[key].used).toBe(true);
      else expect(report.features[key]).toEqual({ configured: true });
    }
    expect(await db('product_usage_markers').pluck('feature')).toHaveLength(56);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    const identity = generateIdentity();
    const envelope = signPacket(makePacket(identity, 'report', 1, report, 'usage.v2'), identity, new Date(report.generated_at));
    expect(verifyEnvelope(envelope, Date.parse(report.generated_at))).toEqual(envelope.packet);
  });

  it('applies parent/AIO gates and does not confuse disabled or expired config with availability', async () => {
    const client = await expandedDb();
    process.env.PICPEAK_SINGLE_CONTAINER = 'yes';
    await db('feature_flags').insert(['bills', 'incomingInvoices', 'expenses', 'taxReport', 'faces', 'incomingMail'].map((key) => ({ key, value: true })));
    await db('api_tokens').insert([
      { revoked_at: '2026-01-01', expires_at: null },
      { revoked_at: null, expires_at: '2026-01-01' }
    ]);
    await db('webhooks').insert({ active: false });
    await db('mail_accounts').insert({ enabled: false, imap_host: 'PRIVATE', imap_user: 'PRIVATE', imap_pass: 'PRIVATE' });
    await db('event_feedback_settings').insert({ feedback_enabled: false, identity_mode: 'guest', allow_likes: true });
    await db('events').insert({ allow_user_uploads: false, reveal_mode: true });
    const report = await client.snapshot();
    for (const key of ['crm_invoices', 'accounting_incoming_invoices', 'accounting_expenses', 'accounting_tax_report', 'face_recognition', 'api_integration', 'webhooks', 'incoming_mail', 'gallery_feedback_likes', 'gallery_guest_accounts', 'gallery_reveal']) expect(report.features[key].configured).toBe(false);
    expect(report.features.galleries).toEqual({ configured: true, used: false });
    expect(report.features.admin_management.configured).toBe(true);
    expect(report.features.analytics_dashboard.configured).toBe(true);
  });

  it('handles missing optional tables, global protection defaults and durable consent boundaries', async () => {
    db = await bootDb();
    const client = service(db);
    await db('app_settings').insert({ setting_key: 'default_protection_level', setting_value: '"enhanced"' });
    await client.markUsed(FEATURE_KEYS);
    expect(await db('product_usage_markers').pluck('feature')).toEqual([]);
    await db('product_usage_state').update({ status: 'active' });
    await client.markUsed(['video_uploads', 'api_integration']);
    expect(await db('product_usage_markers').pluck('feature')).toEqual([]);
    expect(Object.keys((await client.snapshot()).features)).toHaveLength(19);
    await db('product_usage_state').update({ consent_version: 'usage-consent.v2' });
    const report = await client.snapshot();
    expect(report.features.gallery_image_protection).toEqual({ configured: true });
    expect(report.features.api_integration).toEqual({ configured: false, used: false });
    expect(report.features.document_templates).toEqual({ configured: false, used: false });
    await client.markUsed(['video_uploads', 'gallery_downloads']);
    expect(await db('product_usage_markers').pluck('feature')).toEqual(['video_uploads']);
    await db('product_usage_state').update({ status: 'deletion_pending' });
    await client.markUsed(['api_integration']);
    expect(await db('product_usage_markers').pluck('feature')).toEqual(['video_uploads']);
  });
});
