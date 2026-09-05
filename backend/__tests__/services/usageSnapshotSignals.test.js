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

async function bootDb() {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.schema.createTable('product_usage_state', (t) => {
    t.integer('id').primary();
    t.string('status', 30).notNullable().defaultTo('disabled');
    t.boolean('notice_dismissed').notNullable().defaultTo(false);
    t.string('installation_id', 64);
    t.string('public_key', 59);
    t.text('private_key_encrypted');
    t.string('instance_binding', 64);
    t.bigInteger('sequence').notNullable().defaultTo(0);
    t.text('pending_packet'); t.text('last_packet'); t.text('last_receipt');
    t.string('last_report_date', 10); t.string('last_error', 80);
    t.text('feedback_preferences'); t.string('lease_token', 36);
    t.bigInteger('lease_until').notNullable().defaultTo(0);
    t.bigInteger('cancel_seq').notNullable().defaultTo(0);
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
