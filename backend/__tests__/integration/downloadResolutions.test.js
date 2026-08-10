/**
 * Download resolutions (#858).
 *
 * Pins the contracts that are easy to break later:
 *
 *  - the global → per-event cascade, including NULL = inherit
 *  - the picker never offers a size ABOVE the standard (a photographer who
 *    lowers the standard is not silently handing out full-res), and 'Original'
 *    only reappears when the admin explicitly allows it
 *  - `fit: 'inside'` + no-upscaling resize semantics, which is exactly what
 *    the requester asked for on the issue
 *  - a guest-supplied resolution is validated against the policy rather than
 *    trusted
 */

const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// Both modules under test pull in src/database/db.js transitively. bootCrmDb
// only works when it runs BEFORE the first require of db.js (it sets
// TEST_DATABASE_PATH, which knexfile reads at module-init time), so these are
// required lazily in beforeAll rather than at module scope — otherwise knex
// binds to the shared default SQLite file and every run after the first one
// fails with "table `migrations` already exists".
let resolveEventDownloadPolicy;
let pickRequestedResolution;
let parseResolution;
let invalidateDownloadGlobals;
let resizeToBox;

describe('Download resolutions (#858)', () => {
  let db;
  let cleanup;

  const setGlobal = async (key, value) => {
    await db('app_settings').where({ setting_key: key }).del();
    await db('app_settings').insert({
      setting_key: key,
      setting_value: JSON.stringify(value),
      setting_type: 'download',
      updated_at: new Date().toISOString(),
    });
    invalidateDownloadGlobals();
  };

  const PRESETS = [
    { label: 'Large', width: 3000, height: 2000 },
    { label: 'Medium', width: 1500, height: 1000 },
    { label: 'Small', width: 800, height: 600 },
  ];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    ({
      resolveEventDownloadPolicy,
      pickRequestedResolution,
      parseResolution,
      invalidateDownloadGlobals,
    } = require('../../src/utils/downloadResolutions'));
    ({ resizeToBox } = require('../../src/services/imageProcessor'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await setGlobal('download_resolutions', PRESETS);
    await setGlobal('download_standard_resolution', 'original');
    await setGlobal('download_resolution_picker_enabled', false);
    await setGlobal('download_allow_original', false);
  });

  describe('cascade', () => {
    it('inherits the global standard when the event has no override', async () => {
      await setGlobal('download_standard_resolution', '1500x1000');
      const policy = await resolveEventDownloadPolicy({ download_standard_resolution: null });
      expect(policy.standard).toBe('1500x1000');
      expect(policy.standardBox).toEqual({ width: 1500, height: 1000 });
    });

    it('lets an event override the global standard', async () => {
      await setGlobal('download_standard_resolution', '1500x1000');
      const policy = await resolveEventDownloadPolicy({ download_standard_resolution: '800x600' });
      expect(policy.standard).toBe('800x600');
    });

    it('treats a NULL picker flag as inherit and an explicit false as override', async () => {
      await setGlobal('download_resolution_picker_enabled', true);
      expect((await resolveEventDownloadPolicy({ download_resolution_picker_enabled: null })).pickerEnabled).toBe(true);
      expect((await resolveEventDownloadPolicy({ download_resolution_picker_enabled: false })).pickerEnabled).toBe(false);
    });
  });

  describe('choice list', () => {
    it('never offers a size larger than the standard', async () => {
      await setGlobal('download_standard_resolution', '1500x1000');
      const { choices } = await resolveEventDownloadPolicy({});
      expect(choices.map((c) => c.id)).toEqual(['1500x1000', '800x600']);
      // The regression that matters: 3000x2000 must not be reachable.
      expect(choices.some((c) => c.id === '3000x2000')).toBe(false);
    });

    it('bounds EACH dimension, not the pixel area (codex review round 2)', async () => {
      // 2000x700 is 1.4MP — under 1500x1000's 1.5MP — so an area comparison
      // would offer it and hand back a 2000px-wide file despite a 1500px cap.
      await setGlobal('download_resolutions', [
        ...PRESETS,
        { label: 'Wide', width: 2000, height: 700 },
      ]);
      await setGlobal('download_standard_resolution', '1500x1000');
      const { choices } = await resolveEventDownloadPolicy({});
      expect(choices.some((c) => c.id === '2000x700')).toBe(false);
    });

    it('omits Original when the standard is capped and the admin has not allowed it', async () => {
      await setGlobal('download_standard_resolution', '1500x1000');
      const { choices } = await resolveEventDownloadPolicy({});
      expect(choices.some((c) => c.id === 'original')).toBe(false);
    });

    it('re-adds Original when the admin explicitly allows it', async () => {
      await setGlobal('download_standard_resolution', '1500x1000');
      await setGlobal('download_allow_original', true);
      const { choices } = await resolveEventDownloadPolicy({});
      expect(choices[0].id).toBe('original');
    });

    it('offers Original when the standard already is original', async () => {
      const { choices } = await resolveEventDownloadPolicy({});
      expect(choices[0].id).toBe('original');
      expect(choices.map((c) => c.id)).toContain('3000x2000');
    });
  });

  describe('request validation', () => {
    it('falls back to the standard when nothing is requested', async () => {
      await setGlobal('download_standard_resolution', '1500x1000');
      const policy = await resolveEventDownloadPolicy({});
      expect(pickRequestedResolution(policy, undefined)).toBe('1500x1000');
    });

    it('refuses any explicit request while the picker is off', async () => {
      const policy = await resolveEventDownloadPolicy({});
      expect(policy.pickerEnabled).toBe(false);
      expect(pickRequestedResolution(policy, '800x600')).toBeNull();
    });

    it('refuses a size that is not on the offered list', async () => {
      await setGlobal('download_resolution_picker_enabled', true);
      await setGlobal('download_standard_resolution', '1500x1000');
      const policy = await resolveEventDownloadPolicy({});
      // Above the standard → not offered → rejected rather than silently served.
      expect(pickRequestedResolution(policy, '3000x2000')).toBeNull();
      expect(pickRequestedResolution(policy, '9999x9999')).toBeNull();
      expect(pickRequestedResolution(policy, '800x600')).toBe('800x600');
    });

    it('parses only well-formed resolution ids', () => {
      expect(parseResolution('original')).toBeNull();
      expect(parseResolution(null)).toBeNull();
      expect(parseResolution('abc')).toBeNull();
      expect(parseResolution('0x0')).toBeNull();
      expect(parseResolution('1500x1000')).toEqual({ width: 1500, height: 1000 });
    });
  });

  describe('job dedup identity (codex review round 1)', () => {
    // The leak this pins: a PIN client's archive contains hidden photos. If the
    // dedup key ignored the visibility scope, a guest asking for the same size
    // would be handed the client's job token — and the delivery route only
    // checked the event id.
    let jobService;

    beforeAll(() => {
      jobService = require('../../src/services/downloadJobService');
    });

    it('separates client and guest archives of the same size and photo set', () => {
      const guest = jobService.dedupKey(1, '1500x1000', [1, 2, 3], false, 'public');
      const client = jobService.dedupKey(1, '1500x1000', [1, 2, 3], false, 'hidden');
      expect(guest).not.toBe(client);
    });

    it('keys on the RESOLVED photo set, so a stale archive is not reused', () => {
      const before = jobService.dedupKey(1, '1500x1000', [1, 2, 3], false, 'public');
      const afterUpload = jobService.dedupKey(1, '1500x1000', [1, 2, 3, 4], false, 'public');
      const afterHide = jobService.dedupKey(1, '1500x1000', [1, 2], false, 'public');
      expect(new Set([before, afterUpload, afterHide]).size).toBe(3);
    });

    it('is order-independent for the same set', () => {
      expect(jobService.dedupKey(1, 'original', [3, 1, 2], true, 'public'))
        .toBe(jobService.dedupKey(1, 'original', [1, 2, 3], true, 'public'));
    });

    it('maps access levels onto the two visibility scopes', () => {
      expect(jobService.visibilityScopeFor('client')).toBe('hidden');
      expect(jobService.visibilityScopeFor('guest')).toBe('public');
      expect(jobService.visibilityScopeFor(undefined)).toBe('public');
    });
  });

  describe('resize semantics', () => {
    const make = (w, h) => sharp({
      create: { width: w, height: h, channels: 3, background: { r: 10, g: 100, b: 200 } },
    }).jpeg().toBuffer();

    const box = { width: 1500, height: 1000 };

    it('fits a 3:2 photo exactly into a 3:2 box', async () => {
      const out = await sharp(await resizeToBox(await make(6000, 4000), box)).metadata();
      expect([out.width, out.height]).toEqual([1500, 1000]);
    });

    it('treats the box as an "up to" bound for other aspect ratios', async () => {
      // Portrait: height is the binding edge, width comes out smaller.
      const portrait = await sharp(await resizeToBox(await make(4000, 6000), box)).metadata();
      expect(portrait.height).toBe(1000);
      expect(portrait.width).toBeLessThan(1500);

      const fourThree = await sharp(await resizeToBox(await make(4000, 3000), box)).metadata();
      expect(fourThree.height).toBe(1000);
      expect(fourThree.width).toBeLessThan(1500);
    });

    it('never upscales an image already smaller than the box', async () => {
      const out = await sharp(await resizeToBox(await make(800, 600), box)).metadata();
      expect([out.width, out.height]).toEqual([800, 600]);
    });

    it('passes the buffer through untouched for the original size', async () => {
      const src = await make(4000, 3000);
      expect(await resizeToBox(src, null)).toBe(src);
    });

    it('keeps the source format so the filename and mime type stay honest', async () => {
      // A .gif re-encoded as JPEG would ship mislabelled bytes, since the
      // download routes keep the original filename and mime type.
      const gif = await sharp({
        create: { width: 4000, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } },
      }).gif().toBuffer();
      const out = await sharp(await resizeToBox(gif, box)).metadata();
      expect(out.format).toBe('gif');
      expect(out.width).toBe(1333);
    });

    it('returns the input rather than throwing on an undecodable source', async () => {
      const junk = Buffer.from('not an image');
      expect(await resizeToBox(junk, box)).toBe(junk);
    });
  });
});
