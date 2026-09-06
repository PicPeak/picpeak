const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { UsageService } = require('../../src/usage/UsageService');
const p = require('../../src/usage/protocol.cjs');
const { expandSnapshot } = require('../../src/usage/expandedSnapshot');
const { capabilityEvidence } = require('../../src/usage/capabilityEvidence');

for (const engine of ['sqlite3', ...(process.env.PICPEAK_PG_TEST_URL ? ['pg'] : [])]) {
  describe(`usage.v3 on ${engine}`, () => {
    let db, admin, schema, client;
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    const savedEnv = { ...process.env };
    beforeEach(async () => {
      if (engine === 'pg') {
        admin = knex({ client: 'pg', connection: process.env.PICPEAK_PG_TEST_URL });
        schema = `usage_v3_${crypto.randomUUID().replaceAll('-', '')}`;
        await admin.schema.createSchema(schema);
        db = knex({ client: 'pg', connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema] });
      } else db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
      const migrations = path.resolve(__dirname, '../../migrations/core');
      for (const file of fs.readdirSync(migrations).filter(name => /^20[1-6]_product_usage/.test(name)).sort())
        await require(path.join(migrations, file)).up(db);
      await db('product_usage_state').where({ id: 1 }).update({ status: 'active', consent_version: 'usage-consent.v3' });
      await db.schema.createTable('app_settings', t => { t.string('setting_key').primary(); t.text('setting_value'); });
      await db.schema.createTable('feature_flags', t => { t.string('key').primary(); t.boolean('value'); });
      await db.schema.createTable('events', t => {
        t.increments('id'); t.text('color_theme'); t.string('external_path'); t.integer('css_template_id');
        t.string('default_photo_sort'); t.boolean('is_archived'); t.boolean('is_draft'); t.boolean('allow_downloads');
      });
      await db.schema.createTable('photos', t => { t.increments('id'); t.integer('event_id'); t.string('media_type'); t.string('filename'); });
      await db.schema.createTable('css_templates', t => { t.increments('id'); t.boolean('is_enabled'); t.text('css_content'); });
      await db.schema.createTable('photo_categories', t => { t.increments('id'); t.integer('event_id'); t.boolean('is_folder'); });
      await db.schema.createTable('workflows', t => { t.increments('id'); t.boolean('enabled'); });
      await db.schema.createTable('transfers', t => {
        t.increments('id'); t.string('upload_token'); t.boolean('allow_uploads'); t.timestamp('deleted_at'); t.timestamp('upload_expires_at'); t.timestamp('expires_at');
      });
      for (const table of ['email_configs', 'mail_accounts'])
        await db.schema.createTable(table, t => { t.increments('id'); t.string('smtp_host'); });
      await db.schema.createTable('whatsapp_configs', t => { t.increments('id'); t.boolean('enabled'); t.string('phone_number_id'); t.string('access_token'); });
      client = new UsageService(db, { now: () => now, secret: 'v3-test-only-secret'.repeat(3) });
    });
    afterEach(async () => {
      process.env = { ...savedEnv };
      await db?.destroy();
      if (admin) { await admin.schema.dropSchema(schema, true); await admin.destroy(); admin = null; }
    });

    test('counts retained gallery/photo records, excluding videos, without loading entities', async () => {
      await db('events').insert([{ is_draft: true }, { is_archived: true }, { is_archived: false }]);
      await db('photos').insert([
        { event_id: 1, media_type: 'image', filename: 'PRIVATE-original.dng' },
        { event_id: 2, media_type: null, filename: 'PRIVATE-archive.jpg' },
        { event_id: 3, media_type: 'video', filename: 'PRIVATE-video.mov' },
      ]);
      const queries = [];
      db.on('query', q => queries.push(q.sql));
      const report = await client.snapshot();
      expect(report.inventory).toEqual({ galleries: 3, photos: 2 });
      expect(Object.keys(report.features)).toHaveLength(86);
      expect(queries.filter(sql => /from ["`]photos["`]/.test(sql))).toEqual([expect.stringMatching(/select count\(\*\)/)]);
      expect(JSON.stringify(report)).not.toContain('PRIVATE');
      const identity = p.generateIdentity();
      const envelope = p.signPacket(p.makePacket(identity, 'report', 1, report), identity, new Date(now));
      expect(p.verifyEnvelope(envelope, now).payload).toEqual(report);
      await db('photos').where({ id: 1 }).delete();
      await db('events').where({ id: 1 }).delete();
      expect((await client.snapshot()).inventory).toEqual({ galleries: 2, photos: 1 });
    });

    test.each(['usage.v1', 'usage.v2'])('%s consent never collects v3 markers or counts', async (version) => {
      await db('product_usage_state').where({ id: 1 }).update({ consent_version: p.CONSENT_VERSIONS[version] });
      const queries = [];
      db.on('query', q => queries.push(q.sql));
      await client.markUsed(['crm_invoice_import', 'photo_admin_marks', 'face_recognition']);
      const report = await client.preview();
      expect(report).not.toHaveProperty('inventory');
      expect(report.features).not.toHaveProperty('crm_invoice_import');
      expect(await db('product_usage_markers').pluck('feature')).toEqual(['face_recognition']);
      expect(queries.filter(sql => /from ["`]photos["`]/.test(sql))).toEqual([]);
      expect(queries.some(sql => /count\(\*\)/.test(sql))).toBe(false);
      expect((await client.status()).consent_update_available).toBe(true);
    });

    test('only allowed successful-capability bits survive and preview is read-only', async () => {
      const res = { locals: {} };
      capabilityEvidence(res, 'photo_xmp_export', 'photo_replacement', 'photo_admin_marks', 'crm_invoice_import',
        'crm_combined_billing', 'crm_monthly_billing_manual', 'crm_document_conversion', 'PRIVATE@example.test', 'gallery_folders');
      await client.markUsed(res.locals.productUsageFeatures);
      expect(await db('product_usage_markers').pluck('feature')).toHaveLength(7);
      const before = await db('product_usage_markers').orderBy('feature');
      const report = await client.preview();
      expect(report.inventory).toEqual({ galleries: 0, photos: 0 });
      expect(report.features.crm_invoice_import.used).toBe(true);
      expect(report.features.gallery_folders).not.toHaveProperty('used');
      expect(await db('product_usage_markers').orderBy('feature')).toEqual(before);
      await db('product_usage_state').where({ id: 1 }).update({ status: 'deletion_pending' });
      await client.markUsed(['face_recognition']);
      expect(await db('product_usage_markers').where({ feature: 'face_recognition' })).toHaveLength(0);
    });

    test('configuration reflects effective modules, applicable folders and unexpired upload permission', async () => {
      await db('events').insert({ default_photo_sort: 'capture_date_asc' });
      await db('photo_categories').insert({ event_id: 1, is_folder: true });
      await db('workflows').insert({ enabled: true });
      await db('transfers').insert({ upload_token: 'PRIVATE', allow_uploads: true, upload_expires_at: '2026-09-07T00:00:00.000Z' });
      await db('app_settings').insert({ setting_key: 'general_use_original_filenames_for_downloads', setting_value: 'true' });
      process.env.STORAGE_BACKEND = 's3'; process.env.STORAGE_AUTO_IMPORT = 'true';
      process.env.STORAGE_S3_BUCKET = 'PRIVATE'; process.env.STORAGE_S3_ACCESS_KEY = 'PRIVATE'; process.env.STORAGE_S3_SECRET_KEY = 'PRIVATE';
      const snap = flags => expandSnapshot(db, { features: p.emptyFeatures('usage.v1'), flags, used: new Set(), now, version: 'usage.v3' });
      const enabled = await snap({ transfers: true, workflows: true, quotes: true, bills: true, incomingInvoices: true });
      for (const key of ['gallery_folders', 'transfer_upload_links', 'workflow_automation_enabled', 's3_auto_import', 'gallery_capture_date_sort', 'download_original_filenames', 'crm_invoice_import', 'crm_combined_billing'])
        expect(enabled[key].configured).toBe(true);
      expect(JSON.stringify(enabled)).not.toContain('PRIVATE');
      const disabled = await snap({ transfers: false, workflows: false, quotes: false, bills: true });
      for (const key of ['transfer_upload_links', 'workflow_automation_enabled', 'crm_invoice_import', 'crm_combined_billing'])
        expect(disabled[key].configured).toBe(false);
      await db('transfers').update({ upload_expires_at: '2026-09-06T12:00:00.000Z' });
      expect((await snap({ transfers: true })).transfer_upload_links.configured).toBe(false);
      await db('transfers').update({ upload_expires_at: null, expires_at: '2026-09-07T00:00:00.000Z' });
      expect((await snap({ transfers: true })).transfer_upload_links.configured).toBe(true);
      await db('transfers').update({ deleted_at: '2026-09-06T11:00:00.000Z' });
      expect((await snap({ transfers: true })).transfer_upload_links.configured).toBe(false);
      await db('photo_categories').update({ event_id: 999 });
      expect((await snap({})).gallery_folders.configured).toBe(false);
    });

    test('gallery_downloads_restricted counts galleries with downloads switched off, and v2 keeps its old key', async () => {
      // allow_downloads ships true, so the v2 key was true on every install
      // with a gallery. Only switching downloads off is a decision.
      const snap = version => expandSnapshot(db, { features: p.emptyFeatures('usage.v1'), flags: {}, used: new Set(), now, version });
      expect((await snap('usage.v3')).gallery_downloads_restricted).toEqual({ configured: false });
      expect(await snap('usage.v3')).not.toHaveProperty('gallery_downloads');
      await db('events').insert([{ allow_downloads: true }, { allow_downloads: true }]);
      expect((await snap('usage.v3')).gallery_downloads_restricted.configured).toBe(false);
      expect((await snap('usage.v2')).gallery_downloads).toEqual({ configured: true });
      expect(await snap('usage.v2')).not.toHaveProperty('gallery_downloads_restricted');
      await db('events').insert({ allow_downloads: false });
      expect((await snap('usage.v3')).gallery_downloads_restricted.configured).toBe(true);
      expect((await snap('usage.v2')).gallery_downloads.configured).toBe(true);
    });

    test('a report queued under the replaced catalog is rebuilt in place, keeping its packet id', async () => {
      const identity = p.generateIdentity();
      const posted = [];
      const service = new UsageService(db, {
        now: () => now, secret: 'v3-test-only-secret'.repeat(3), endpoint: 'http://127.0.0.1:9/',
        fetch: async (_url, init) => { posted.push(JSON.parse(init.body).packet); throw new Error('collector unreachable'); },
      });
      service.binding = async () => 'b'.repeat(64);
      const report = (features) => ({
        picpeak_version: '1.0.0', report_date: '2026-09-05', generated_at: new Date(now).toISOString(),
        features, gallery_layouts: [], inventory: { galleries: 0, photos: 0 },
      });
      // The v3 catalog as it stood before gallery_downloads_restricted replaced gallery_downloads.
      const { gallery_downloads_restricted, ...rest } = p.emptyFeatures('usage.v3');
      const stale = { ...rest, gallery_downloads: gallery_downloads_restricted };
      const seed = (payload) => db('product_usage_state').where({ id: 1 }).update({
        status: 'active', installation_id: identity.installation_id, public_key: identity.public_key,
        private_key_encrypted: service.encrypt(identity.private_key), instance_binding: 'b'.repeat(64),
        sequence: 1, last_error: null, attempts: 3, next_attempt_at: now + 60_000,
        pending_packet: JSON.stringify(p.makePacket(identity, 'report', 2, payload, 'usage.v3')),
      });

      await seed(report(stale));
      const queued = JSON.parse((await db('product_usage_state').where({ id: 1 }).first()).pending_packet);
      await service.deliver(await db('product_usage_state').where({ id: 1 }).first());
      // Sent once, under the current catalog, as the same packet.
      expect(posted).toHaveLength(1);
      expect(posted[0].packet_id).toBe(queued.packet_id);
      expect(posted[0].sequence).toBe(2);
      expect(posted[0].payload.features).toHaveProperty('gallery_downloads_restricted');
      expect(posted[0].payload.features).not.toHaveProperty('gallery_downloads');
      // The rebuilt packet is what stays queued for the ordinary retry path.
      let row = await db('product_usage_state').where({ id: 1 }).first();
      const retained = JSON.parse(row.pending_packet);
      expect(retained.packet_id).toBe(queued.packet_id);
      expect(retained.payload.features).toHaveProperty('gallery_downloads_restricted');
      expect(row.status).toBe('active');
      expect(row.last_error).toBe('DELIVERY_FAILED');

      // Narrow: a report that still validates is sent as queued, payload untouched.
      await seed(report(p.emptyFeatures('usage.v3')));
      await service.deliver(await db('product_usage_state').where({ id: 1 }).first());
      expect(posted).toHaveLength(2);
      expect(posted[1].payload.report_date).toBe('2026-09-05');
      row = await db('product_usage_state').where({ id: 1 }).first();
      expect(JSON.parse(row.pending_packet).payload.report_date).toBe('2026-09-05');
    });

    test('ML recognition is already represented without querying faces or results', async () => {
      await db('feature_flags').insert({ key: 'faces', value: true });
      await client.markUsed(['face_recognition']);
      expect((await client.snapshot()).features.face_recognition).toEqual({ configured: true, used: true });
      process.env.PICPEAK_SINGLE_CONTAINER = 'true';
      expect((await client.snapshot()).features.face_recognition).toEqual({ configured: false, used: true });
      // No faces, people, embeddings or recognition-result tables exist in this fixture.
    });
  });
}
