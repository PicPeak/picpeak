/**
 * The event's "watermark downloads" flag reads the same on the view and the
 * download path (issue 2612).
 *
 * The photo route and the photo-sales rules took true, 1 and '1' as on;
 * downloadRendition.resolveWatermarkSettings, behind every download route and
 * download job, took true and 1 only. A row holding '1' was then marked in
 * the lightbox and handed out clean as a download.
 */
jest.mock('../../src/database/db', () => ({ db: () => ({ where: () => ({ first: async () => null }) }) }));

const watermarkService = require('../../src/services/watermarkService');
const { resolveWatermarkSettings } = require('../../src/services/downloadRendition');
const { resolvePhotoSalesWatermarkSettings } = require('../../src/modules/photoSales/priceRules');
const { eventWatermarksDownloads } = require('../../src/utils/watermarkDownloads');

const GLOBAL_OFF = { enabled: false, position: 'bottom-right', opacity: 50, size: 15, text: 'PicPeak' };

beforeEach(() => {
  jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue(GLOBAL_OFF);
});
afterEach(() => jest.restoreAllMocks());

describe('watermark_downloads', () => {
  test('the download path treats watermark_downloads \'1\' as on', async () => {
    const settings = await resolveWatermarkSettings({ id: 1, watermark_downloads: '1' });
    expect(settings).toEqual(expect.objectContaining({ enabled: true }));
  });

  test.each([true, 1, '1'])('%p is on for the view and the download path alike', async (flag) => {
    const event = { id: 1, watermark_downloads: flag };
    expect(eventWatermarksDownloads(event)).toBe(true);
    expect((await resolveWatermarkSettings(event))?.enabled).toBe(true);
    expect((await resolvePhotoSalesWatermarkSettings(event, { id: 7 }))?.enabled).toBe(true);
  });

  test.each([false, 0, '0', null, undefined, 'true'])('%p is off for both while the global mark is off', async (flag) => {
    const event = { id: 1, watermark_downloads: flag };
    expect(eventWatermarksDownloads(event)).toBe(false);
    expect(await resolveWatermarkSettings(event)).toBeNull();
    expect(await resolvePhotoSalesWatermarkSettings(event, { id: 7 })).toBeNull();
  });
});
