'use strict';

/**
 * The transfer upload policy has exactly one writer (#1544).
 *
 * `PUT /admin/settings/transfers` is gated on the `transfers` feature flag and
 * refuses an empty allowlist. That is only worth anything if it is the ONLY way
 * these keys can be written: the generic settings writers (`/general`,
 * `/analytics`, `/seo`, `/security`) upsert arbitrary `setting_key`s, so an
 * unreserved key could be set through one of them with the feature flag off —
 * and `getTransferUploadPolicy` reads the key directly, so the public upload
 * route would immediately start honouring it.
 *
 * Same reasoning the repo already applies to `oidc_*` (#798) and `download_*`
 * (#858). This pins it for the transfer keys, because a backend gate another
 * endpoint can write around is not a gate.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/routes/adminSettings.js'), 'utf8');

// Rebuild the predicate from source rather than importing it — adminSettings
// pulls in the whole app graph, and the reserved-key list is a declaration, not
// behaviour that needs a running server.
function isReservedSettingKey(key) {
  const listMatch = SOURCE.match(/const RESERVED_SETTING_KEYS = \[([\s\S]*?)\];/);
  const exact = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const fnMatch = SOURCE.match(/const isReservedSettingKey = \(key\) =>([\s\S]*?);\n/);
  const body = fnMatch[1];
  const prefixes = [...body.matchAll(/key\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
  const equals = [...body.matchAll(/key === '([^']+)'/g)].map((m) => m[1]);

  return exact.includes(key)
    || equals.includes(key)
    || prefixes.some((p) => key.startsWith(p));
}

describe('transfer upload policy keys are reserved from the generic settings writers', () => {
  it.each([
    'transfer_upload_accept_all',
    'transfer_upload_allowed_types',
    'transfer_upload_allowed_mime',
    'transfer_max_upload_size_mb',
  ])('%s is reserved', (key) => {
    expect(isReservedSettingKey(key)).toBe(true);
  });

  it('still reserves the keys it reserved before, so this did not widen the strip', () => {
    for (const key of ['oidc_client_secret', 'download_resolutions', 'setup_token']) {
      expect(isReservedSettingKey(key)).toBe(true);
    }
  });

  it('leaves ordinary general keys writable', () => {
    for (const key of ['general_site_name', 'general_allowed_file_types', 'transfer_default_expiry_days']) {
      expect(isReservedSettingKey(key)).toBe(false);
    }
  });

  it('strips reserved keys in every generic writer, not only one', () => {
    // The strip is what enforces the reservation; a writer that upserts without
    // calling it reopens the bypass for its own route.
    const writers = [...SOURCE.matchAll(/router\.put\(\s*'\/(general|analytics|seo|security)'/g)].map((m) => m[1]);
    expect(writers.sort()).toEqual(['analytics', 'general', 'security', 'seo']);
    // One call per generic writer.
    const strips = SOURCE.match(/stripReservedSettingKeys\(/g) || [];
    expect(strips.length).toBeGreaterThanOrEqual(writers.length);
  });
});
