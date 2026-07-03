/**
 * Coverage for the changelog aggregation introduced for #567.
 *
 * `getReleasesSince` is what feeds the update-available modal so the
 * admin can see release notes for every version between their current
 * version and latest. The cases below pin:
 *
 *   - Strictly-newer filtering (the running version itself never
 *     appears in the list).
 *   - Channel filtering (a stable user does not see beta releases,
 *     and vice versa).
 *   - Empty-result fallback when the GitHub fetch returns nothing
 *     (cached null from `fetchAvailableVersions`).
 *
 * We mock axios's GitHub response — these tests are pure logic, no
 * network. Cache is cleared between cases via the service's exported
 * `clearCache()` to avoid bleed.
 */

jest.mock('axios');
const axios = require('axios');
const { getReleasesSince, clearCache } = require('../../src/services/updateCheckService');

function release(tag, body = '', publishedAt = '2026-01-01T00:00:00Z') {
  return {
    tag_name: tag,
    name: tag,
    body,
    published_at: publishedAt,
    html_url: `https://github.com/PicPeak/picpeak/releases/tag/${tag}`,
  };
}

describe('updateCheckService.getReleasesSince', () => {
  beforeEach(() => {
    clearCache();
    axios.get.mockReset();
  });

  it('returns only releases strictly newer than current, for the requested channel', async () => {
    axios.get.mockResolvedValue({
      data: [
        release('v3.55.0', 'stable notes 3.55.0'),
        release('v3.54.0', 'stable notes 3.54.0'),
        release('v3.43.1', 'stable notes 3.43.1 — the running version, should be excluded'),
        release('v3.43.0'),
        release('v3.55.0-beta.0', 'beta notes — wrong channel, excluded'),
        release('v3.54.0-beta.5'),
      ],
    });

    const result = await getReleasesSince('3.43.1', 'stable');

    expect(result.map((r) => r.version)).toEqual(['3.55.0', '3.54.0']);
    // Body + html_url + publishedAt are preserved so the modal can render them
    expect(result[0]).toMatchObject({
      version: '3.55.0',
      tag: 'v3.55.0',
      name: 'v3.55.0',
      body: 'stable notes 3.55.0',
      htmlUrl: 'https://github.com/PicPeak/picpeak/releases/tag/v3.55.0',
    });
  });

  it('returns only beta releases for a beta user', async () => {
    axios.get.mockResolvedValue({
      data: [
        release('v3.55.0-beta.0'),
        release('v3.54.7-beta.0'),
        release('v3.55.0'), // stable — wrong channel for a beta user
        release('v3.54.6-beta.0'),
      ],
    });

    const result = await getReleasesSince('3.54.6-beta.0', 'beta');

    // Strictly newer beta-channel only — does not include 3.55.0 stable
    // even though it's a newer release, because the beta channel user
    // wants to see beta releases (which can include releases that
    // landed on the beta line after the stable cut).
    expect(result.map((r) => r.version)).toEqual(['3.55.0-beta.0', '3.54.7-beta.0']);
  });

  it('returns empty array when GitHub fetch fails (e.g. rate-limited)', async () => {
    axios.get.mockRejectedValue(new Error('API rate limit exceeded'));

    const result = await getReleasesSince('3.43.1', 'stable');

    expect(result).toEqual([]);
  });

  it('returns empty array when the user is already on the latest version', async () => {
    axios.get.mockResolvedValue({
      data: [release('v3.55.0'), release('v3.54.0')],
    });

    const result = await getReleasesSince('3.55.0', 'stable');

    expect(result).toEqual([]);
  });
});
