/**
 * Responsive preview tiers (#1095).
 *
 * A phone can display ~1170px at most, so the single 1920px preview ships
 * roughly twice the bytes it can use on every lightbox swipe — and the
 * lightbox prefetches neighbours, so a guest flicking through a wedding
 * gallery on cellular pays that repeatedly.
 *
 * The width is whitelisted rather than free-form: every distinct value is a
 * permanent cache entry on disk, so an open ?w= is an invitation to fill the
 * volume with renditions nobody asked for.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-tiers-'));
process.env.TEST_DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'tiers-test-secret';
process.env.STORAGE_PATH = path.join(tmpRoot, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });

const sharp = require('sharp');
const imageProcessor = require('../../src/services/imageProcessor');
const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup;

describe('preview tiers (#1095)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  describe('normalizeTierWidth', () => {
    const { normalizeTierWidth, PREVIEW_WIDTHS, THUMBNAIL_WIDTHS } = imageProcessor;

    it('accepts every advertised width', () => {
      for (const w of PREVIEW_WIDTHS) {
        expect(normalizeTierWidth(String(w), PREVIEW_WIDTHS)).toBe(w);
      }
      for (const w of THUMBNAIL_WIDTHS) {
        expect(normalizeTierWidth(String(w), THUMBNAIL_WIDTHS)).toBe(w);
      }
    });

    it('rejects anything not on the list', () => {
      // The disk-filling cases: arbitrary sizes, and a caller walking a range.
      for (const bad of ['999', '1921', '0', '-100', '99999']) {
        expect(normalizeTierWidth(bad, PREVIEW_WIDTHS)).toBeNull();
      }
    });

    it('rejects junk without throwing', () => {
      // Straight off a query string, so it is whatever the client sent.
      for (const bad of [undefined, null, '', 'abc', '12abc', {}, [], '1e3', 'NaN']) {
        expect(normalizeTierWidth(bad, PREVIEW_WIDTHS)).toBeNull();
      }
    });

    it('does not let a thumbnail width through the preview list', () => {
      // The two lists are separate on purpose; 600 is a thumb tier, not a
      // preview tier, and vice versa for 1280.
      expect(normalizeTierWidth('600', PREVIEW_WIDTHS)).toBeNull();
      expect(normalizeTierWidth('1280', THUMBNAIL_WIDTHS)).toBeNull();
    });
  });

  describe('ensurePreviewImageAtWidth', () => {
    async function seedPhoto() {
      const [e] = await db('events').insert({
        slug: `tier-${Math.random().toString(36).slice(2, 8)}`,
        event_type: 'wedding',
        event_name: 'tier',
        event_date: '2026-01-01',
        host_email: 'h@example.com',
        admin_email: 'a@example.com',
        password_hash: 'x',
        share_link: `tier-${Math.random()}`,
        expires_at: new Date().toISOString(),
      }).returning('id');
      const eventId = typeof e === 'object' ? e.id : e;

      // A real image on disk under STORAGE_PATH, since the managed branch
      // resolves through storage rather than a mount.
      const rel = `events/active/tier/${Math.random().toString(36).slice(2, 8)}.jpg`;
      const abs = path.join(process.env.STORAGE_PATH, rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 90, b: 160 } } })
        .jpeg().toFile(abs);

      const [p] = await db('photos').insert({
        event_id: eventId,
        filename: path.basename(rel),
        path: rel.replace(/^events\/active\//, ''),
        type: 'individual',
        width: 3000,
        height: 2000,
        processing_status: 'complete',
        source_origin: 'managed',
      }).returning('id');
      return db('photos').where({ id: typeof p === 'object' ? p.id : p }).first();
    }

    it('scopes keys by photo id so two galleries cannot collide', async () => {
      // The leak: managed auto-imports keep camera basenames, so two events can
      // each hold an IMG_0001.jpg. A tier is served straight from a cache hit
      // without re-reading the source, so a shared key hands one gallery's
      // photo to another.
      const a = await seedPhoto();
      const b = await seedPhoto();
      await db('photos').where({ id: a.id }).update({ path: 'wedding-a/IMG_0001.jpg' });
      await db('photos').where({ id: b.id }).update({ path: 'wedding-b/IMG_0001.jpg' });

      const keyA = imageProcessor.previewTierKeys(await db('photos').where({ id: a.id }).first())[0];
      const keyB = imageProcessor.previewTierKeys(await db('photos').where({ id: b.id }).first())[0];

      expect(keyA).not.toBe(keyB);
      expect(keyA).toContain(`p${a.id}_`);
      expect(keyB).toContain(`p${b.id}_`);
    });

    it('derives every non-default tier key for cleanup', () => {
      // Tiers live outside preview_path, so delete/archive/regenerate have no
      // other way to find them. 1920 is excluded because that IS preview_path.
      const keys = imageProcessor.previewTierKeys({ id: 5, path: 'e/a.jpg', source_origin: 'managed' });
      expect(keys).toHaveLength(imageProcessor.PREVIEW_WIDTHS.length - 1);
      expect(keys.some((k) => k.includes('w1920'))).toBe(false);
      expect(keys.every((k) => k.includes('p5_'))).toBe(true);
    });

    it('deletePreviewTiers removes generated tiers from storage', async () => {
      const photo = await seedPhoto();
      const key = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);
      const abs = path.join(process.env.STORAGE_PATH, key);
      expect(fs.existsSync(abs)).toBe(true);

      await imageProcessor.deletePreviewTiers(await db('photos').where({ id: photo.id }).first());
      expect(fs.existsSync(abs)).toBe(false);
    });

    it('produces a distinct key per width and never touches preview_path', async () => {
      const photo = await seedPhoto();

      const small = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);
      expect(small).toContain('preview_w640_');

      // The extra tiers are cache, not state. Writing them to the row would
      // mean the last size requested silently becomes "the" preview.
      const row = await db('photos').where({ id: photo.id }).first();
      expect(row.preview_path == null || !String(row.preview_path).includes('w640')).toBe(true);
    });

    it('resolves the default width to the canonical preview, not a w1920 copy', async () => {
      // Otherwise every existing install grows a duplicate of every preview it
      // already has, for no benefit.
      const photo = await seedPhoto();
      const def = await imageProcessor.ensurePreviewImageAtWidth(photo, 1920);
      expect(def).not.toContain('preview_w1920_');
    });

    it('reuses the cached tier instead of regenerating', async () => {
      const photo = await seedPhoto();
      const first = await imageProcessor.ensurePreviewImageAtWidth(photo, 1280);
      expect(first).toBeTruthy();

      const abs = path.join(process.env.STORAGE_PATH, first);
      const before = (await fs.promises.stat(abs)).mtimeMs;
      await new Promise((r) => setTimeout(r, 20));

      const second = await imageProcessor.ensurePreviewImageAtWidth(photo, 1280);
      expect(second).toBe(first);
      expect((await fs.promises.stat(abs)).mtimeMs).toBe(before);
    });

    it('actually resizes to the requested tier', async () => {
      const photo = await seedPhoto();
      const key = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);
      const meta = await sharp(path.join(process.env.STORAGE_PATH, key)).metadata();
      // 3000x2000 constrained to a 640 long edge.
      expect(Math.max(meta.width, meta.height)).toBe(640);
      expect(meta.height).toBe(Math.round(640 * (2000 / 3000)));
    });
  });
});
