/**
 * The gallery's own watermark text (issue 2095).
 *
 * Every caller handed the gallery's watermark_text to the renderer as `text`,
 * while the renderer only drew the global company name, and it put that name
 * into the SVG unescaped, so a `<` or `&` made the mark fail to render.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');

jest.mock('../../src/database/db', () => {
  const api = (table) => {
    if (table === 'app_settings') {
      return { where: () => ({ whereIn: () => [], first: async () => null }), whereIn: () => ({ select: async () => [] }) };
    }
    return { where: () => ({ first: async () => null }) };
  };
  return { db: api };
});

// Real sharp, with every composite layer recorded so the SVG can be read.
const mockLayers = [];
jest.mock('../../src/services/isolatedSharp', () => {
  const real = jest.requireActual('sharp');
  const wrapped = (...args) => {
    const instance = real(...args);
    const composite = instance.composite.bind(instance);
    instance.composite = (layers) => { mockLayers.push(...layers); return composite(layers); };
    return instance;
  };
  return Object.assign(wrapped, real);
});

const watermarkService = require('../../src/services/watermarkService');

const base = { enabled: true, logoPath: null, position: 'bottom-right', opacity: 50, size: 15 };

describe('watermark text', () => {
  let tmpDir;
  let photo;
  let narrow;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-wmtext-'));
    photo = path.join(tmpDir, 'photo.jpg');
    await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 90, g: 120, b: 60 } } }).jpeg().toFile(photo);
    narrow = path.join(tmpDir, 'narrow.jpg');
    await sharp({ create: { width: 120, height: 400, channels: 3, background: { r: 90, g: 120, b: 60 } } }).jpeg().toFile(narrow);
  });
  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    mockLayers.length = 0;
    watermarkService.clearCache();
  });

  const drawnSvg = () => {
    expect(mockLayers).toHaveLength(1);
    return mockLayers[0].input.toString('utf8');
  };

  test('draws the text the caller passes instead of the company name', async () => {
    const out = await watermarkService.applyWatermark(photo,
      { ...base, companyName: 'Global Studio', text: 'Anna and Ben' }, { failClosed: true });
    const svg = drawnSvg();
    expect(svg).toContain('Anna and Ben');
    expect(svg).not.toContain('Global Studio');
    expect((await sharp(out).metadata()).width).toBe(800);
  });

  test('falls back to the company name without a text', async () => {
    await watermarkService.applyWatermark(photo, { ...base, companyName: 'Global Studio', text: '   ' }, { failClosed: true });
    expect(drawnSvg()).toContain('Global Studio');
  });

  test.each([
    ['the gallery text', { companyName: 'Studio', text: 'Anna & Ben <3 "forever" \'24' }],
    ['the company name', { companyName: 'Smith & Sons <Photo> "Studio" \'24' }],
  ])('escapes %s, so the SVG still parses and sharp renders it', async (_label, fields) => {
    // failClosed: a mark that fails to render throws instead of handing back
    // the unmarked original.
    await expect(watermarkService.applyWatermark(photo, { ...base, ...fields }, { failClosed: true }))
      .resolves.toBeInstanceOf(Buffer);
    const svg = drawnSvg();
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&quot;');
    expect(svg).toContain('&apos;');
    expect(svg).not.toMatch(/& |<3|<Photo>/);
    await expect(sharp(Buffer.from(svg)).metadata()).resolves.toMatchObject({ format: 'svg' });
  });

  test('a long text is sized to fit a narrow image', async () => {
    await expect(watermarkService.applyWatermark(narrow,
      { ...base, companyName: 'S', text: 'A very long watermark text for a narrow photo & more' }, { failClosed: true }))
      .resolves.toBeInstanceOf(Buffer);
    const svg = drawnSvg();
    const width = Number(svg.match(/<svg width="(\d+)"/)[1]);
    expect(width).toBeLessThanOrEqual(120);
  });

  test('forEvent applies the gallery text and drops any other', () => {
    const settings = { ...base, companyName: 'Studio', text: 'stale' };
    expect(watermarkService.forEvent(settings, { watermark_text: '  Anna  ' })).toEqual({ ...base, companyName: 'Studio', text: 'Anna' });
    expect(watermarkService.forEvent(settings, { watermark_text: '' })).toEqual({ ...base, companyName: 'Studio' });
    expect(watermarkService.forEvent(settings, { watermark_text: null })).toEqual({ ...base, companyName: 'Studio' });
    expect(watermarkService.forEvent(null, { watermark_text: 'Anna' })).toBeNull();
  });

  test('the version tag changes with the gallery text and only then', () => {
    const plain = watermarkService.versionTag(base);
    expect(plain).toBe('50bottom-right15');
    const anna = watermarkService.versionTag({ ...base, text: 'Anna' });
    expect(anna).not.toBe(plain);
    expect(watermarkService.versionTag({ ...base, text: 'Ben' })).not.toBe(anna);
    expect(anna).toMatch(/^[\w-]+$/);
  });
});
