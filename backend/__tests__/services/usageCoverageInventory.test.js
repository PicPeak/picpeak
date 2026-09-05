const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalog = require('../../src/usage/features.v2.json');
const inventory = require('../../../docs/usage-coverage.v2.json');
const protocol = require('../../src/usage/schema.cjs');
const { RULES_V2, capabilityKeys } = require('../../src/usage/capabilityRules');
const { acceptedUpload, capabilityEvidence } = require('../../src/usage/capabilityEvidence');

test('every route family and literal route declaration has an explicit privacy decision', () => {
  const root = path.resolve(__dirname, '../../src/routes');
  const actual = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(file, 'utf8');
        actual[path.relative(root, file)] = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*(['"])([^'"]+)\2/g)]
          .map((m) => `${m[1].toUpperCase()} ${m[3]}`);
      }
    }
  }
  walk(root);
  expect(Object.keys(inventory.route_families).sort()).toEqual(Object.keys(actual).sort());
  for (const [file, decision] of Object.entries(inventory.route_families)) {
    expect(decision.reason.length).toBeGreaterThan(30);
    expect(decision.route_signatures).toEqual(actual[file]);
    for (const signal of decision.signals) expect(catalog.features[signal]).toBeDefined();
  }
});

test('all flags and catalog capabilities have a documented decision', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/routes/adminFeatureFlags.js'), 'utf8');
  const array = source.match(/const KNOWN_FLAGS = \[([\s\S]*?)\];/)[1].replace(/\/\/[^\n]*/g, '');
  const flags = [...array.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(Object.keys(inventory.feature_flags).sort()).toEqual(flags.sort());
  for (const key of protocol.FEATURE_KEYS)
    expect(Object.values(inventory.route_families).some((family) => family.signals.includes(key))).toBe(true);
  expect(inventory.configuration_only.sort()).toEqual(protocol.FEATURE_KEYS.filter((key) => !protocol.observesUse(key)).sort());
});

test('all current settings tabs have an explicit scope decision', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/pages/admin/SettingsPage.tsx'), 'utf8');
  const union = source.match(/type TabType =([\s\S]*?);/)[1].replace(/\/\/[^\n]*/g, '');
  const tabs = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(Object.keys(inventory.settings_tabs).sort()).toEqual(tabs.sort());
  for (const entry of Object.values(inventory.settings_tabs)) {
    expect(entry.reason.length).toBeGreaterThan(20);
    for (const key of entry.signals) expect(catalog.features[key]).toBeDefined();
  }
});

test('v1 wire validation is immutable; catalog, UI and translated descriptions agree', () => {
  expect(crypto.createHash('sha256').update(JSON.stringify(protocol.envelopeSchemas['usage.v1'].properties)).digest('hex'))
    .toBe('cc8d0a865d21e36d2b24d23ca6aa8dd8d48000cb17aef83996786f70755bc922');
  expect(protocol.FEATURE_KEYS).toHaveLength(73);
  expect(protocol.LEGACY_FEATURE_KEYS).toHaveLength(19);
  expect(inventory.configuration_only).toHaveLength(17);
  const frontend = path.resolve(__dirname, '../../../frontend');
  expect(JSON.parse(fs.readFileSync(path.join(frontend, 'src/features/settings/usageFeatures.v2.json')))).toEqual(catalog);
  for (const lang of ['en', 'de']) {
    const translated = JSON.parse(fs.readFileSync(path.join(frontend, `src/i18n/locales/${lang}.json`))).productUsage.catalog;
    for (const [key, value] of Object.entries(catalog.features)) {
      expect(translated[key]).toEqual({ name: value.name[lang], configured: value.configured[lang], ...(value.used ? { used: value.used[lang] } : {}) });
    }
  }
});

test('every used field has either a fixed route rule or explicit trusted success evidence', () => {
  const explicit = ['custom_css', 'oauth', 'smtp', 'email_webhook', 'whatsapp', 'incoming_mail',
    'video_uploads', 'camera_raw_uploads', 's3_storage', 's3_photo_storage', 's3_backups', 'api_integration'];
  const covered = new Set([...explicit, ...RULES_V2.flatMap(([, , keys]) => keys)]);
  expect(protocol.FEATURE_KEYS.filter(protocol.observesUse).filter((key) => !covered.has(key))).toEqual([]);
  for (const key of covered) expect(protocol.observesUse(key)).toBe(true);
});

test.each([
  ['POST', '/events', 'galleries'], ['POST', '/events/123/publish', 'galleries'],
  ['POST', '/photos/repair-dimensions', 'photo_processing'], ['GET', '/events/123/photos/456/download', 'photo_exports'],
  ['PUT', '/events/123/slideshow', 'slideshow'], ['POST', '/expenses/inbound', 'accounting_incoming_invoices'],
  ['POST', '/expenses', 'accounting_expenses'], ['GET', '/tax-report/csv', 'accounting_tax_report'],
  ['POST', '/deals/123/installment-plan', 'crm_installments'], ['GET', '/ledger/export', 'accounting_ledger'],
  ['POST', '/quotes/presets', 'document_templates'], ['PUT', '/cms/pages/home', 'cms'],
  ['POST', '/webhooks/123/test', 'webhooks'], ['POST', '/webhooks/123/deliveries/456/replay', 'webhooks'],
  ['POST', '/email/send', 'messaging'], ['PUT', '/feedback/feedback/123/approve', 'feedback_moderation'],
  ['GET', '/events/123/guests/export-all', 'guest_management'], ['POST', '/backup/picpeak/import', 'portable_backup'],
  ['PUT', '/roles/123', 'admin_management'], ['POST', '/newsletters/123/queue', 'newsletters']
])('fixed allowlist recognizes %s %s', (method, url, expected) => {
  expect(capabilityKeys(method, url)).toContain(expected);
  expect(JSON.stringify(capabilityKeys(method, url))).not.toContain('123');
});

test.each([
  ['GET', '/events/faces/health'], ['GET', '/photos/repair-dimensions/status'],
  ['POST', '/events/123/validate-rename'], ['POST', '/photos/123/chunked-upload/init'],
  ['POST', '/photos/123/chunked-upload/456/chunk/0'], ['GET', '/dashboard/health'],
  ['GET', '/customers'], ['GET', '/email/queue'], ['POST', '/email/flush-queue'],
  ['POST', '/newsletters/123/recipients/resolve'], ['POST', '/newsletters/123/preview'],
  ['POST', '/users/123/reset-password'], ['PUT', '/settings/security'],
  ['POST', '/gallery/a/feedback'], ['POST', '/public/newsletter/unsubscribe'],
  ['POST', '/customer/quotes/123/accept'], ['POST', '/usage/consent']
])('no v2 observation for excluded %s %s', (method, url) => expect(capabilityKeys(method, url)).toEqual([]));

test('trusted upload evidence retains only constant keys and configuration-only use cannot be recorded', () => {
  const res = { locals: {} };
  acceptedUpload(res, { video: true, raw: true, s3: true });
  capabilityEvidence(res, 'PRIVATE-user@example.test', 'gallery_feedback_likes');
  expect(res.locals.productUsageFeatures.sort()).toEqual(['photo_management', 'video_uploads', 'camera_raw_uploads', 's3_storage', 's3_photo_storage'].sort());
});
