/**
 * Download menu (issue 1733, E2): the gallery payload says whether downloads
 * carry a watermark by the rule the download routes apply
 * (resolveWatermarkSettings) — the global branding watermark OR the
 * gallery's own flag. `watermark_downloads` alone misses the global one, and
 * the menu would then promise an untouched original it does not hand out.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('gallery payload: download_resolution.watermarked', () => {
  let tmpDir; let db; let cleanup; let service; let eventId;

  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-wm-menu-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.JWT_SECRET = 'wm-menu-test';
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });

    jest.resetModules();
    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    service = require('../../src/services/galleryQueryService');

    eventId = idOf(await db('events').insert({
      slug: 'wm', event_type: 'other', event_name: 'Watermark', event_date: '2026-07-03',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/wm/s', share_token: 'wm-share',
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const setGlobalWatermark = async (enabled) => {
    await db('app_settings').where({ setting_key: 'branding_watermark_enabled' }).del();
    await db('app_settings').insert({
      setting_key: 'branding_watermark_enabled',
      setting_value: JSON.stringify(enabled),
      setting_type: 'branding',
      updated_at: new Date().toISOString(),
    });
  };

  const watermarked = async () => {
    const event = await db('events').where('id', eventId).first();
    const payload = await service.getGalleryPhotos({ event, identity: { guestIdentifier: 'x' }, accessLevel: 'guest', slug: 'wm' });
    return payload.event.download_resolution.watermarked;
  };

  it('is false with neither watermark on', async () => {
    await setGlobalWatermark(false);
    await db('events').where('id', eventId).update({ watermark_downloads: 0 });
    expect(await watermarked()).toBe(false);
  });

  it('is true for the gallery flag alone', async () => {
    await setGlobalWatermark(false);
    await db('events').where('id', eventId).update({ watermark_downloads: 1 });
    expect(await watermarked()).toBe(true);
  });

  it('is true for the global branding watermark, which watermark_downloads does not show', async () => {
    await setGlobalWatermark(true);
    await db('events').where('id', eventId).update({ watermark_downloads: 0 });
    const event = await db('events').where('id', eventId).first();
    const payload = await service.getGalleryPhotos({ event, identity: { guestIdentifier: 'x' }, accessLevel: 'guest', slug: 'wm' });
    expect(payload.event.watermark_downloads).toBe(false);
    expect(payload.event.download_resolution.watermarked).toBe(true);
  });
});
