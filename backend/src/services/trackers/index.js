/**
 * Pluggable analytics-tracker registry (#663 Phase 1).
 *
 * Read the `analytics_tracker_provider` app_setting → return the matching
 * adapter, configured with that provider's secrets. Used by the dashboard
 * route to fetch the device breakdown from whichever tracker the operator
 * picked, or null when the choice is "none" / "custom" (custom mode injects
 * a script tag client-side but doesn't expose a metrics API back to us).
 *
 *   const adapter = await resolveAdapter();
 *   if (adapter) {
 *     const devices = await adapter.fetchDeviceBreakdown({ startMs, endMs });
 *     if (devices) return devices;
 *   }
 *   // …fall back to local access_logs heuristic
 *
 * Back-compat: when `analytics_tracker_provider` is unset (every pre-#663
 * install) we fall through to the legacy "is Umami enabled?" shape so the
 * device-breakdown fix that landed in #662 keeps working without an admin
 * touching settings. Once the admin picks an explicit provider from the
 * dropdown introduced in this PR, that wins.
 */

const { getAppSetting } = require('../../utils/appSettings');
const umami = require('./umamiAdapter');
const rybbit = require('./rybbitAdapter');

const VALID_PROVIDERS = ['none', 'umami', 'rybbit', 'custom'];

/**
 * Read all the tracker-related settings in one go and decide which adapter
 * to instantiate. Returns null when no metrics adapter applies (None /
 * Custom / unconfigured / missing key).
 */
async function resolveAdapter() {
  const explicit = await getAppSetting('analytics_tracker_provider', null);
  let provider = typeof explicit === 'string' && VALID_PROVIDERS.includes(explicit)
    ? explicit
    : null;

  // Back-compat: when no explicit provider is set, infer from the legacy
  // analytics_umami_enabled flag. Once the admin saves the new dropdown,
  // `provider` is always a string and we skip this.
  if (!provider) {
    const legacyUmami = await getAppSetting('analytics_umami_enabled', false);
    provider = legacyUmami === true ? 'umami' : 'none';
  }

  if (provider === 'umami') {
    return umami.buildAdapter({
      baseUrl: await getAppSetting('analytics_umami_url', null),
      websiteId: await getAppSetting('analytics_umami_website_id', null),
      apiKey: await getAppSetting('analytics_umami_api_key', null),
    });
  }
  if (provider === 'rybbit') {
    return rybbit.buildAdapter({
      baseUrl: await getAppSetting('analytics_rybbit_url', null),
      websiteId: await getAppSetting('analytics_rybbit_website_id', null),
      apiKey: await getAppSetting('analytics_rybbit_api_key', null),
    });
  }
  // 'none' and 'custom' have no metrics adapter — caller falls back to
  // access_logs (Custom mode is purely a client-side script slot).
  return null;
}

module.exports = {
  resolveAdapter,
  VALID_PROVIDERS,
  // Exported for tests + direct injection in unit-level scenarios where
  // resolveAdapter's getAppSetting calls would be overkill.
  buildUmamiAdapter: umami.buildAdapter,
  buildRybbitAdapter: rybbit.buildAdapter,
};
