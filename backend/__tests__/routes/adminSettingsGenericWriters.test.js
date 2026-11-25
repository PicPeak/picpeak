/**
 * Behaviour pins for the generic settings writers PUT /general, /security,
 * /analytics and /seo, and for the generic reads GET /, GET /:type and
 * GET /customer-surface (issue 2615: the four writers share one skeleton and
 * the reads one parse loop). Every response body, stored value, activity row
 * and side effect asserted here must stay exactly as it is.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-genwriters-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'genwriters-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-genwriters-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { decodeSettingValue } = require('../helpers/settingValue');
const vault = require('../../src/utils/galleryPasswordVault');
const {
  MAX_ALLOWED_FILES_PER_UPLOAD, MAX_ALLOWED_FILE_SIZE_MB,
} = require('../../src/services/uploadSettings');

const MASK = '••••••••';
const ROUTES = {
  general: { message: 'General settings updated successfully', error: 'Failed to update general settings' },
  security: { message: 'Security settings updated successfully', error: 'Failed to update security settings' },
  analytics: { message: 'Analytics settings updated successfully', error: 'Failed to update analytics settings' },
  seo: { message: 'SEO settings updated successfully', error: 'Failed to update SEO settings' },
};

describe('generic settings writers and reads (behaviour pins)', () => {
  let db; let cleanup; let app;
  let adminId; let superTok; let editTok; let viewTok;
  let eventId;
  const evidence = [];

  const auth = (req, tok = superTok) => req.set('Authorization', `Bearer ${tok}`);
  const put = (route, body, tok) => auth(request(app).put(`/api/admin/settings/${route}`), tok).send(body);
  const row = (key) => db('app_settings').where({ setting_key: key }).first();
  const value = async (key) => {
    const r = await row(key);
    return r ? decodeSettingValue(db, r.setting_value) : undefined;
  };
  const lastActivity = async () => {
    const r = await db('activity_logs').orderBy('id', 'desc').first();
    return { ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata };
  };
  const isPg = () => db.client.config.client === 'pg';

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    superTok = mintAdminToken(adminId);

    const mkUser = async (name, permissions) => {
      const role = await svc.createRole({ name, permissions }, adminId);
      const ins = await db('admin_users').insert({
        username: name, email: `${name}@example.com`, password_hash: 'x',
        role_id: role.id, must_change_password: false, created_at: new Date(),
      }).returning('id');
      return mintAdminToken(ins[0]?.id ?? ins[0]);
    };
    editTok = await mkUser('pin_editor', ['settings.view', 'settings.edit']);
    viewTok = await mkUser('pin_viewer', ['settings.view']);

    const [ev] = await db('events').insert({
      slug: 'pin-writers', event_name: 'pin-writers', event_type: 'wedding', password_hash: 'unused',
      host_email: 'sample@example.test', admin_email: 'admin@example.test',
      share_link: '/gallery/pin-writers', created_by: adminId,
    }).returning('id');
    eventId = ev?.id ?? ev;
    clearPermissionCache();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, res, next) => {
      res.once('finish', () => evidence.push({
        path: req.path, status: res.statusCode, features: res.locals.productUsageFeatures || [],
      }));
      next();
    });
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe.each(Object.keys(ROUTES))('PUT /%s', (route) => {
    const { message, error } = ROUTES[route];

    it('writes the setting, strips reserved and logo-url keys, logs one activity row', async () => {
      const key = `pin_${route}_value`;
      const stripped = ['setup_token', 'setup_wizard_completed', 'branding_logo_url',
        'general_site_url_env_pinned', 'analytics_dashboard_cookie_domain'];
      const snapshot = async () => Promise.all(stripped.map(async (k) => {
        const r = await row(k);
        return r ? { key: r.setting_key, value: r.setting_value, type: r.setting_type } : null;
      }));
      const before = await snapshot();
      const res = await put(route, {
        [key]: { nested: [1, 'two'] },
        setup_token: 'nope',
        setup_wizard_completed: false,
        branding_logo_url: '/elsewhere.png',
        general_site_url_env_pinned: true,
        analytics_dashboard_cookie_domain: 'x.example',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message });
      const stored = await row(key);
      expect(stored.setting_type).toBe(route);
      expect(decodeSettingValue(db, stored.setting_value)).toEqual({ nested: [1, 'two'] });
      expect(await snapshot()).toEqual(before);
      const act = await lastActivity();
      expect(act.activity_type).toBe(`${route}_settings_updated`);
      expect(act.actor_type).toBe('admin');
      expect(Number(act.actor_id)).toBe(Number(adminId));
      expect(act.actor_name).toBe('tester');
      expect(act.metadata).toEqual({ settings_count: 1 });
    });

    it('keeps setting_type on conflict and updates only the value', async () => {
      const key = `pin_${route}_conflict`;
      await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify('old'), setting_type: 'legacy' });
      const res = await put(route, { [key]: 'new' });
      expect(res.status).toBe(200);
      const stored = await row(key);
      expect(stored.setting_type).toBe('legacy');
      expect(decodeSettingValue(db, stored.setting_value)).toBe('new');
    });

    it('rejects route-owned keys with 400 and writes nothing', async () => {
      const before = await db('activity_logs').count({ c: '*' }).first();
      const res = await put(route, { backup_s3_bucket: 'b', rate_limit_window_ms: 1, [`pin_${route}_owned`]: 1 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'These settings are saved through their own configuration endpoint, not the general settings',
        code: 'SETTINGS_OWNED_ELSEWHERE',
        keys: ['backup_s3_bucket', 'rate_limit_window_ms'],
      });
      expect(await row(`pin_${route}_owned`)).toBeUndefined();
      const after = await db('activity_logs').count({ c: '*' }).first();
      expect(Number(after.c)).toBe(Number(before.c));
    });

    it('is refused without the route permission', async () => {
      const res = await put(route, { [`pin_${route}_denied`]: 1 }, viewTok);
      expect(res.status).toBe(403);
      expect(await row(`pin_${route}_denied`)).toBeUndefined();
      const edit = await put(route, { [`pin_${route}_edit`]: 1 }, editTok);
      expect(edit.status).toBe(route === 'security' ? 403 : 200);
    });

    it('rejects a protected key the caller may not change with 403 naming it', async () => {
      if (route === 'security') return; // settings.edit cannot reach the route at all
      const res = await put(route, { security_pin_protected: true, [`pin_${route}_unprotected`]: 1 }, editTok);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.keys).toEqual([{ key: 'security_pin_protected', perm: 'settings.security' }]);
      expect(await row(`pin_${route}_unprotected`)).toBeUndefined();
    });

    it('answers 500 with the route error when the activity insert fails, after the upsert', async () => {
      const key = `pin_${route}_failed_log`;
      await db.schema.renameTable('activity_logs', 'activity_logs_pin');
      let res;
      try {
        res = await put(route, { [key]: 'written' });
      } finally {
        await db.schema.renameTable('activity_logs_pin', 'activity_logs');
      }
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error });
      expect(await value(key)).toBe('written');
      const last = evidence[evidence.length - 1];
      expect(last.status).toBe(500);
    });

    it('purges recoverable passwords before switching the vault on and after switching it off', async () => {
      const setVault = (v) => db('app_settings').insert({
        setting_key: vault.SETTING_KEY, setting_value: JSON.stringify(v), setting_type: 'security',
      }).onConflict('setting_key').merge({ setting_value: JSON.stringify(v) });
      const leftover = () => db('events').where('id', eventId).update({ password_recoverable: 'leftover' });
      const stored = async () => (await db('events').where('id', eventId).first('password_recoverable')).password_recoverable;

      await setVault(false);
      await leftover();
      expect((await put(route, { [vault.SETTING_KEY]: true })).status).toBe(200);
      expect(await stored()).toBeNull();

      await leftover();
      expect((await put(route, { [vault.SETTING_KEY]: true })).status).toBe(200);
      expect(await stored()).toBe('leftover'); // same-state save: no purge

      expect((await put(route, { [vault.SETTING_KEY]: false })).status).toBe(200);
      expect(await stored()).toBeNull();
      expect(await value(vault.SETTING_KEY)).toBe(false);
    });
  });

  describe('route-specific validation and side effects', () => {
    it('general: upload limits are floored, range-checked in order, with their messages', async () => {
      const res = await put('general', {
        general_max_files_per_upload: '12.7', general_max_file_size_mb: 3.2, general_max_video_size_mb: '40',
      });
      expect(res.status).toBe(200);
      expect(await value('general_max_files_per_upload')).toBe(12);
      expect(await value('general_max_file_size_mb')).toBe(3);
      expect(await value('general_max_video_size_mb')).toBe(40);

      const cases = [
        [{ general_max_files_per_upload: 0 }, `general_max_files_per_upload must be an integer between 1 and ${MAX_ALLOWED_FILES_PER_UPLOAD}`],
        [{ general_max_files_per_upload: 'abc' }, `general_max_files_per_upload must be an integer between 1 and ${MAX_ALLOWED_FILES_PER_UPLOAD}`],
        [{ general_max_files_per_upload: MAX_ALLOWED_FILES_PER_UPLOAD + 1 }, `general_max_files_per_upload must be an integer between 1 and ${MAX_ALLOWED_FILES_PER_UPLOAD}`],
        [{ general_max_file_size_mb: MAX_ALLOWED_FILE_SIZE_MB + 1 }, `general_max_file_size_mb must be an integer between 1 and ${MAX_ALLOWED_FILE_SIZE_MB}`],
        [{ general_max_video_size_mb: 0.5 }, `general_max_video_size_mb must be an integer between 1 and ${MAX_ALLOWED_FILE_SIZE_MB}`],
        [{ general_max_video_size_mb: Infinity }, `general_max_video_size_mb must be an integer between 1 and ${MAX_ALLOWED_FILE_SIZE_MB}`],
        // The first invalid limit in order wins.
        [{ general_max_video_size_mb: 0, general_max_file_size_mb: 0, general_max_files_per_upload: 0 },
          `general_max_files_per_upload must be an integer between 1 and ${MAX_ALLOWED_FILES_PER_UPLOAD}`],
      ];
      for (const [body, msg] of cases) {
        const bad = await put('general', body);
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ error: msg });
      }
      expect(await value('general_max_files_per_upload')).toBe(12);
    });

    it('general: the boolean keys accept true/"true"/1/"1" only', async () => {
      const keys = [
        'event_default_show_credits_to_guests', 'event_default_walkthrough_enabled',
        'event_default_folder_structure', 'first_look_keyword_detection',
      ];
      for (const truthy of [true, 'true', 1, '1']) {
        expect((await put('general', Object.fromEntries(keys.map((k) => [k, truthy])))).status).toBe(200);
        for (const k of keys) expect(await value(k)).toBe(true);
      }
      for (const falsy of [false, 'yes', 'on', 0, '0', 'TRUE', null, 2]) {
        expect((await put('general', Object.fromEntries(keys.map((k) => [k, falsy])))).status).toBe(200);
        for (const k of keys) expect(await value(k)).toBe(false);
      }
      // The three video switches use the same coercion (their "on" side
      // effects are pinned in the adminSettingsVideo* suites).
      const videoKeys = ['general_video_web_rendition', 'general_video_adaptive_streaming', 'general_video_strip_metadata'];
      for (const falsy of ['yes', 0, 'on']) {
        expect((await put('general', Object.fromEntries(videoKeys.map((k) => [k, falsy])))).status).toBe(200);
        for (const k of videoKeys) expect(await value(k)).toBe(false);
      }
    });

    it('analytics: rejects an unknown provider, and a supported one blanks a stored custom snippet', async () => {
      const bad = await put('analytics', { analytics_tracker_provider: 'bogus' });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'analytics_tracker_provider must be one of: none, umami, rybbit' });

      await db('app_settings').insert({
        setting_key: 'analytics_custom_head_html', setting_value: JSON.stringify('<b>x</b>'), setting_type: 'analytics',
      });
      const ok = await put('analytics', { analytics_tracker_provider: 'none' });
      expect(ok.status).toBe(200);
      expect(await value('analytics_custom_head_html')).toBe('');
      expect(await value('analytics_tracker_provider')).toBe('none');
    });

    it('seo: validates the agent list and custom rules with their messages', async () => {
      const cases = [
        [{ seo_blocked_ai_agents: 'GPTBot' }, 'seo_blocked_ai_agents must be an array of strings'],
        [{ seo_blocked_ai_agents: ['ok', 1] }, 'seo_blocked_ai_agents must be an array of strings'],
        [{ seo_custom_rules: {} }, 'seo_custom_rules must be an array'],
        [{ seo_custom_rules: [{ disallow: [] }] }, 'Each custom rule must have a userAgent string'],
        [{ seo_custom_rules: [{ userAgent: 'x', disallow: [1] }] }, 'Each custom rule must have a disallow array of strings'],
      ];
      for (const [body, msg] of cases) {
        const res = await put('seo', body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: msg });
      }
    });

    it('seo: records seo_editing usage evidence only when a tracked key changes', async () => {
      const first = await put('seo', { seo_allow_indexing: false });
      expect(first.status).toBe(200);
      await db('app_settings').where({ setting_key: 'seo_allow_indexing' }).update({ setting_value: JSON.stringify(true) });
      const changed = await put('seo', { seo_allow_indexing: false });
      expect(changed.status).toBe(200);
      expect(evidence[evidence.length - 1].features).toEqual(['seo_editing']);
      const same = await put('seo', { seo_allow_indexing: false });
      expect(same.status).toBe(200);
      expect(evidence[evidence.length - 1].features).toEqual([]);
      const untracked = await put('seo', { pin_seo_untracked: 'x' });
      expect(untracked.status).toBe(200);
      expect(evidence[evidence.length - 1].features).toEqual([]);
    });

    it('security: a masked reCAPTCHA secret is not written back', async () => {
      await db('app_settings').insert({
        setting_key: 'security_recaptcha_secret_key', setting_value: JSON.stringify('real'), setting_type: 'security',
      });
      const res = await put('security', { security_recaptcha_secret_key: MASK, pin_security_other: 1 });
      expect(res.status).toBe(200);
      expect(await value('security_recaptcha_secret_key')).toBe('real');
      expect((await lastActivity()).metadata).toEqual({ settings_count: 1 });
    });
  });

  describe('generic reads', () => {
    const SECRETS = [
      'security_recaptcha_secret_key', 'backup_s3_secret_key', 'backup_rsync_ssh_key',
      'analytics_umami_api_key', 'analytics_rybbit_api_key',
    ];

    beforeAll(async () => {
      await db('app_settings').whereIn('setting_key', [...SECRETS, 'setup_token', 'customer_show_logo']).del();
      const rows = [
        { setting_key: 'pinread_obj', setting_value: JSON.stringify({ a: 1 }), setting_type: 'pinread' },
        { setting_key: 'pinread_false', setting_value: JSON.stringify(false), setting_type: 'pinread' },
        { setting_key: 'pinread_zero', setting_value: JSON.stringify(0), setting_type: 'pinread' },
        { setting_key: 'pinread_str', setting_value: JSON.stringify('text'), setting_type: 'pinread' },
        { setting_key: 'pinread_null', setting_value: null, setting_type: 'pinread' },
        { setting_key: 'setup_token', setting_value: JSON.stringify('secret-token'), setting_type: 'pinread' },
        // A set secret is masked; an empty one stays as it is.
        { setting_key: 'security_recaptcha_secret_key', setting_value: JSON.stringify('s1'), setting_type: 'pinread' },
        { setting_key: 'backup_s3_secret_key', setting_value: JSON.stringify('s2'), setting_type: 'pinread' },
        { setting_key: 'backup_rsync_ssh_key', setting_value: JSON.stringify('s3'), setting_type: 'pinread' },
        { setting_key: 'analytics_umami_api_key', setting_value: JSON.stringify('s4'), setting_type: 'pinread' },
        { setting_key: 'analytics_rybbit_api_key', setting_value: JSON.stringify(''), setting_type: 'pinread' },
        { setting_key: 'customer_show_logo', setting_value: JSON.stringify(false), setting_type: 'customer_surface' },
        { setting_key: 'customer_pin_null', setting_value: null, setting_type: 'customer_surface' },
      ];
      // Legacy plain text that is not JSON: only the SQLite TEXT column can
      // hold it (PostgreSQL json refuses it on insert).
      if (!isPg()) {
        rows.push({ setting_key: 'pinread_raw', setting_value: 'plain text', setting_type: 'pinread' });
        rows.push({ setting_key: 'customer_pin_raw', setting_value: 'plain', setting_type: 'customer_surface' });
      }
      await db('app_settings').insert(rows);
    });

    const expected = () => ({
      pinread_obj: { a: 1 },
      pinread_false: false,
      pinread_zero: 0,
      pinread_str: 'text',
      pinread_null: null,
      security_recaptcha_secret_key: MASK,
      backup_s3_secret_key: MASK,
      backup_rsync_ssh_key: MASK,
      analytics_umami_api_key: MASK,
      analytics_rybbit_api_key: '',
      ...(isPg() ? {} : { pinread_raw: 'plain text' }),
    });

    it('GET /:type parses, strips reserved keys and masks secrets', async () => {
      const res = await auth(request(app).get('/api/admin/settings/pinread'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected());
    });

    it('GET / returns the same parsed and masked values', async () => {
      const keys = [...Object.keys(expected()), 'setup_token'].join(',');
      const res = await auth(request(app).get(`/api/admin/settings?keys=${keys}`));
      expect(res.status).toBe(200);
      const { general_site_url_env_pinned: pinned, analytics_dashboard_cookie_domain: cookie, ...rest } = res.body;
      expect(typeof pinned).toBe('boolean');
      expect(cookie === null || typeof cookie === 'string' || cookie === undefined).toBe(true);
      expect(rest).toEqual(expected());
    });

    it('GET /customer-surface parses the same way', async () => {
      const res = await auth(request(app).get('/api/admin/settings/customer-surface'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        customer_show_logo: false,
        customer_pin_null: null,
        ...(isPg() ? {} : { customer_pin_raw: 'plain' }),
      });
    });
  });
});
