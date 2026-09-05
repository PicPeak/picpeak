/**
 * PostgreSQL checks for product usage (#1110).
 *
 * Gated: runs only when PICPEAK_PG_TEST_URL points at a throwaway database, e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:picpeak_secure_pass_2024@127.0.0.1:7102/picpeak_usage_pg_test" \
 *     npx jest __tests__/integration/productUsagePg.test.js
 *
 * What SQLite cannot answer:
 *  - `cancel_seq` and `sequence` are bigint, and node-postgres returns bigint
 *    as a STRING. The withdrawal guard compares that value, so a `'1' !== 1`
 *    slip would let an activation complete after an opt-out — and SQLite,
 *    which hands back a number, would never show it.
 *  - booleans are real booleans here, not 0/1, which is what every
 *    `configured` signal in a report is built from.
 *  - markUsed takes SELECT ... FOR UPDATE on this engine only.
 */
const knex = require('knex');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

maybe('product usage on Postgres', () => {
  let db;
  let UsageService;

  beforeAll(async () => {
    // Its own schema, not `public`. CI hands every gated suite the same
    // PICPEAK_PG_TEST_URL and runs jest with parallel workers, and both
    // picpeakRestorePg and externalRelpathFoldPg drop and recreate `events`
    // and `app_settings` there. Sharing that would have made all three
    // intermittently destroy each other's fixtures. The service queries
    // unqualified table names, so a searchPath keeps it entirely in here.
    const bootstrap = knex({
      client: 'pg', connection: PG_URL, pool: { min: 0, max: 2 }
    });
    await bootstrap.raw('DROP SCHEMA IF EXISTS usage_pg_test CASCADE');
    await bootstrap.raw('CREATE SCHEMA usage_pg_test');
    await bootstrap.destroy();

    db = knex({
      client: 'pg',
      connection: PG_URL,
      searchPath: ['usage_pg_test'],
      pool: { min: 0, max: 10 }
    });
    // The real migrations, on the real engine.
    await require('../../migrations/core/201_product_usage').up(db);
    await require('../../migrations/core/202_product_usage_cancel_requested').up(db);
    await require('../../migrations/core/203_product_usage_cancel_seq').up(db);
    await require('../../migrations/core/204_product_usage_privacy_receipts').up(db);

    await db.schema.createTable('app_settings', (t) => {
      t.string('setting_key').primary(); t.text('setting_value'); t.string('setting_type');
    });
    await db.schema.createTable('feature_flags', (t) => {
      t.string('key').primary(); t.boolean('value');
    });
    await db.schema.createTable('events', (t) => {
      t.increments('id'); t.text('color_theme'); t.string('external_path'); t.integer('css_template_id');
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

    ({ UsageService } = require('../../src/usage/UsageService'));
  }, 120000);

  afterAll(async () => {
    if (db) {
      await db.raw('DROP SCHEMA IF EXISTS usage_pg_test CASCADE');
      await db.destroy();
    }
    fs.rmSync(bindingDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db('product_usage_markers').delete();
    await db('product_usage_state').delete();
    await db('product_usage_state').insert({ id: 1 });
    await db('events').delete();
    await db('css_templates').delete();
    await db('feature_flags').delete();
    await db('app_settings').delete();
  });

  // The instance-binding file defaults to STORAGE_PATH, which is '/storage'
  // in a bare test process. Point it at a temp dir so the real binding code
  // runs rather than being stubbed out.
  const bindingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-usage-pg-'));

  const service = (over = {}) =>
    new UsageService(db, {
      secret: 'p'.repeat(48),
      endpoint: 'http://127.0.0.1:9/',
      bindingPath: path.join(bindingDir, 'usage-instance.key'),
      fetch: async () => { throw new Error('collector unreachable in tests'); },
      ...over,
    });

  it('creates the columns with the types the code expects', async () => {
    const cols = await db('product_usage_state').columnInfo();
    expect(cols.cancel_seq).toBeDefined();
    expect(cols.cancel_requested).toBeUndefined(); // dropped by 203
    expect(cols.sequence).toBeDefined();
    expect(cols.privacy_receipts).toBeDefined();
  });

  it('reruns the receipt migration safely and scrubs legacy plaintext sessions', async () => {
    const migration = require('../../migrations/core/204_product_usage_privacy_receipts');
    await db('product_usage_state').where({ id: 1 }).update({
      last_receipt: JSON.stringify({ status: 'accepted', session_token: 'synthetic-old-token' })
    });
    await migration.up(db);
    await migration.up(db);
    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(JSON.parse(row.last_receipt)).toEqual({ status: 'accepted' });
  });

  it('reads bigint cancel_seq correctly even though pg returns it as a string', async () => {
    await db('product_usage_state').where({ id: 1 }).update({ cancel_seq: 5 });
    const row = await db('product_usage_state').where({ id: 1 }).first();
    // The thing SQLite hides: this is a string here.
    expect(typeof row.cancel_seq).toBe('string');
    expect(Number(row.cancel_seq)).toBe(5);
  });

  it('honours a withdrawal that lands while an activation is starting', async () => {
    const svc = service();
    const realBinding = svc.binding.bind(svc);
    svc.binding = async (create = false) => {
      // The withdrawal lands inside the window where the row still reads
      // `disabled`, with the real binding write still happening.
      if (create) await svc.disable();
      return realBinding(create);
    };
    await svc.enable('usage-consent.v1');

    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.status).toBe('disabled');
    expect(row.installation_id).toBeNull();
  });

  it('activates when no withdrawal arrives', async () => {
    await service().enable('usage-consent.v1');
    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.status).toBe('activation_pending');
    expect(row.installation_id).not.toBeNull();
  });

  it('records markers only while active, using SELECT ... FOR UPDATE', async () => {
    const svc = service();
    await svc.markUsed(['crm']);
    expect(await db('product_usage_markers').count('* as c').first()).toMatchObject({ c: '0' });

    await db('product_usage_state').where({ id: 1 }).update({ status: 'active' });
    await svc.markUsed(['crm', 'newsletters']);
    const rows = await db('product_usage_markers').pluck('feature');
    expect(rows.sort()).toEqual(['crm', 'newsletters']);

    // onConflict().ignore() must not throw on a repeat.
    await svc.markUsed(['crm']);
    expect((await db('product_usage_markers').pluck('feature')).length).toBe(2);
  });

  it('builds a report from real booleans, not 0/1', async () => {
    await db('feature_flags').insert([
      { key: 'clients', value: true },
      { key: 'newsletters', value: false },
    ]);
    await db('product_usage_state').where({ id: 1 }).update({ status: 'active' });
    await service().markUsed(['crm']);

    const report = await service().snapshot();
    expect(report.features.crm.configured).toBe(true);
    expect(report.features.crm.used).toBe(true);
    expect(report.features.newsletters.configured).toBe(false);
  });

  it('resolves preset layouts and template CSS on this engine too', async () => {
    const [tpl] = await db('css_templates').insert({ is_enabled: true, css_content: '.a{}' }).returning('id');
    const templateId = typeof tpl === 'object' ? tpl.id : tpl;
    await db('events').insert([
      { color_theme: 'modernMasonry' },
      { color_theme: null, css_template_id: templateId },
    ]);
    await db('app_settings').insert({
      setting_key: 'theme_config',
      setting_value: JSON.stringify({ galleryLayout: 'carousel' }),
    });

    const report = await service().snapshot();
    expect(report.gallery_layouts.sort()).toEqual(['carousel', 'masonry']);
    expect(report.features.custom_css.configured).toBe(true);
  });
});
