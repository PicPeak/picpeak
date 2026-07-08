const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

// Cache for version info (avoid hitting GitHub API too often)
let versionCache = null;
let lastCheck = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour cache

/**
 * Get current installed version from package.json
 */
async function getCurrentVersion() {
  try {
    const packagePath = path.join(__dirname, '../../package.json');
    const packageContent = await fs.readFile(packagePath, 'utf8');
    const packageJson = JSON.parse(packageContent);
    return packageJson.version || '0.0.0';
  } catch (err) {
    logger.error('Could not read package.json for version:', err);
    return '0.0.0';
  }
}

/**
 * Determine current release channel from version or environment
 */
function getCurrentChannel(version) {
  // Check environment variable first
  const envChannel = process.env.PICPEAK_RELEASE_CHANNEL;
  if (envChannel && ['stable', 'beta'].includes(envChannel)) {
    return envChannel;
  }

  // Infer from version string
  if (version && version.includes('-beta')) {
    return 'beta';
  }
  return 'stable';
}

/**
 * Parse version string into comparable parts
 */
function parseVersion(version) {
  if (!version) return null;

  // Handle versions like "2.3.0" or "2.3.0-beta.1"
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    beta: match[4] ? parseInt(match[4], 10) : null,
    isBeta: !!match[4]
  };
}

/**
 * Compare two versions
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);

  if (!va || !vb) return 0;

  // Compare major.minor.patch
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;

  // Handle beta vs stable
  if (va.isBeta && !vb.isBeta) return -1; // beta < stable
  if (!va.isBeta && vb.isBeta) return 1;  // stable > beta

  // Both are beta - compare beta numbers
  if (va.isBeta && vb.isBeta) {
    if (va.beta !== vb.beta) return va.beta > vb.beta ? 1 : -1;
  }

  return 0;
}

/**
 * Fetch available versions from GitHub Releases
 * Uses GitHub Releases API which is publicly accessible without authentication
 */
async function fetchAvailableVersions() {
  try {
    // Use GitHub Releases API (public, no auth required)
    const response = await axios.get(
      'https://api.github.com/repos/PicPeak/picpeak/releases',
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'PicPeak-Update-Checker'
        },
        timeout: 10000
      }
    );

    // Extract version tags from releases. We keep the full release
    // object (name, body, publishedAt, htmlUrl) so the changelog modal
    // (#567) can render the release notes without a second GitHub API
    // round-trip per modal open.
    const versions = {
      stable: [],
      beta: []
    };

    for (const release of response.data) {
      const tag = release.tag_name;
      if (!tag) continue;

      // Remove 'v' prefix if present
      const version = tag.startsWith('v') ? tag.substring(1) : tag;

      const entry = {
        version,
        tag,
        name: release.name || tag,
        body: release.body || '',
        publishedAt: release.published_at || null,
        htmlUrl: release.html_url || null,
      };

      if (version.match(/^\d+\.\d+\.\d+$/)) {
        versions.stable.push(entry);
      } else if (version.match(/^\d+\.\d+\.\d+-beta\.\d+$/)) {
        versions.beta.push(entry);
      }
    }

    // Sort versions descending (newest first)
    versions.stable.sort((a, b) => compareVersions(b.version, a.version));
    versions.beta.sort((a, b) => compareVersions(b.version, a.version));

    return versions;
  } catch (error) {
    logger.error('Failed to fetch available versions from GitHub:', error.message);
    return null;
  }
}

/**
 * Check for available updates
 */
async function checkForUpdates(forceRefresh = false) {
  const now = Date.now();

  // Use cache if available and not expired
  if (!forceRefresh && versionCache && (now - lastCheck) < CACHE_TTL) {
    return versionCache;
  }

  const currentVersion = await getCurrentVersion();
  const currentChannel = getCurrentChannel(currentVersion);
  const availableVersions = await fetchAvailableVersions();

  if (!availableVersions) {
    return {
      current: currentVersion,
      channel: currentChannel,
      updateAvailable: false,
      error: 'Unable to check for updates'
    };
  }

  // Determine latest version for current channel. Entry shape is
  // `{version, tag, name, body, publishedAt, htmlUrl}` since the rich
  // changelog work (#567); fall back to current when GitHub returned
  // nothing (e.g. brand-new install before any releases exist).
  const latestStable = availableVersions.stable[0]?.version || currentVersion;
  const latestBeta = availableVersions.beta[0]?.version || currentVersion;
  const latestForChannel = currentChannel === 'beta' ? latestBeta : latestStable;

  const updateAvailable = compareVersions(latestForChannel, currentVersion) > 0;

  // Also check if there's a newer beta for stable users who want to preview
  const newerBetaAvailable = currentChannel === 'stable' &&
    availableVersions.beta.length > 0 &&
    compareVersions(latestBeta, currentVersion) > 0;

  const result = {
    current: currentVersion,
    channel: currentChannel,
    latest: {
      stable: latestStable,
      beta: latestBeta,
      forChannel: latestForChannel
    },
    updateAvailable,
    newerBetaAvailable,
    lastChecked: new Date().toISOString()
  };

  // Update cache
  versionCache = result;
  lastCheck = now;

  return result;
}

/**
 * Get the list of releases newer than the running version, filtered to
 * the user's channel. Powers the changelog modal (#567) so the admin
 * sees release notes for every version between current and latest,
 * not just the latest.
 *
 * @returns {Promise<Array<{version, tag, name, body, publishedAt, htmlUrl}>>}
 *   Releases sorted newest-first. Empty array when no update available
 *   or when the GitHub fetch failed.
 */
async function getReleasesSince(currentVersion, channel) {
  const availableVersions = await fetchAvailableVersions();
  if (!availableVersions) return [];

  const list = channel === 'beta' ? availableVersions.beta : availableVersions.stable;
  return list.filter((entry) => compareVersions(entry.version, currentVersion) > 0);
}

/**
 * Clear the version cache (useful for testing)
 */
function clearCache() {
  versionCache = null;
  lastCheck = 0;
}

module.exports = {
  checkForUpdates,
  getCurrentVersion,
  getCurrentChannel,
  getReleasesSince,
  compareVersions,
  parseVersion,
  clearCache
};
