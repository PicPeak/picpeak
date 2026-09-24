/**
 * resizeToBox decided "already fits" from sharp's RAW dimensions, while the
 * resize itself works in the orientation the image is delivered in. For EXIF
 * orientation 5-8 the two are transposed, so a raw 2000x1000 tagged 6 (shown
 * as 1000x2000) "fitted" a 2048x1024 box and came back twice as tall as asked
 * (issue 1639).
 */
const sharp = require('sharp');

jest.mock('../../src/database/db', () => {
  const api = (table) => {
    if (table === 'app_settings') {
      return { where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] };
    }
    return { where: () => ({ first: async () => null }) };
  };
  return { db: api };
});

const { resizeToBox } = require('../../src/services/imageProcessor');

const jpeg = (width, height, orientation) => {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 20 } } }).jpeg();
  return (orientation ? image.withMetadata({ orientation }) : image).toBuffer();
};

// What a viewer shows: oriented width and height.
const delivered = async (buffer) => {
  const meta = await sharp(buffer).metadata();
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  return swap ? [meta.height, meta.width] : [meta.width, meta.height];
};

describe('resizeToBox fit check uses the delivered orientation (issue 1639)', () => {
  it('resizes a rotated photo whose raw size fits a non-square box but whose shown size does not', async () => {
    const input = await jpeg(2000, 1000, 6); // shown as 1000x2000
    const output = await resizeToBox(input, { width: 2048, height: 1024 });

    const [width, height] = await delivered(output);
    expect(width).toBeLessThanOrEqual(2048);
    expect(height).toBeLessThanOrEqual(1024);
    expect([width, height]).toEqual([512, 1024]);
  });

  it.each([5, 7, 8])('does the same for orientation %i', async (orientation) => {
    const output = await resizeToBox(await jpeg(2000, 1000, orientation), { width: 2048, height: 1024 });
    const [width, height] = await delivered(output);
    expect(height).toBeLessThanOrEqual(1024);
    expect(width).toBeLessThanOrEqual(2048);
  });

  it('still hands back the input untouched when the shown size fits', async () => {
    const input = await jpeg(1000, 800, 6); // shown as 800x1000
    const output = await resizeToBox(input, { width: 1024, height: 1024 });
    expect(output).toBe(input);
  });

  it('leaves unrotated photos as before', async () => {
    const fits = await jpeg(2000, 1000);
    expect(await resizeToBox(fits, { width: 2048, height: 1024 })).toBe(fits);

    const [width, height] = await delivered(await resizeToBox(await jpeg(3000, 1500), { width: 2048, height: 1024 }));
    expect([width, height]).toEqual([2048, 1024]);
  });

  // An animation is never rotated by resizeToBox (.rotate() would flatten
  // it), so its fit is decided on the raw frame size, as before issue 1639.
  const animatedWebp = async (width, height, orientation) => {
    const frame = (r) => sharp({ create: { width, height, channels: 3, background: { r, g: 0, b: 0 } } }).png().toBuffer();
    return sharp([await frame(255), await frame(0)], { join: { animated: true } })
      .webp().withMetadata({ orientation }).toBuffer();
  };

  it('resizes an animation whose raw frames exceed the box, keeping every frame', async () => {
    const output = await resizeToBox(await animatedWebp(1000, 2000, 6), { width: 2048, height: 1024 });
    const meta = await sharp(output, { animated: true }).metadata();
    expect(meta.pages).toBe(2);
    expect(meta.width).toBeLessThanOrEqual(2048);
    expect(meta.pageHeight).toBeLessThanOrEqual(1024);
  });

  it('hands back an animation whose raw frames fit the box untouched', async () => {
    const input = await animatedWebp(2000, 1000, 6);
    expect(await resizeToBox(input, { width: 2048, height: 1024 })).toBe(input);
  });
});
