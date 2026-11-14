/**
 * Signature images are bounded by their pixel size, not only their bytes.
 *
 * persistSignatureImage capped the base64 length at 1 MB. A PNG compresses a
 * plain area almost to nothing, so a few kilobytes can declare a raster pdf-lib
 * then inflates to gigabytes when it stamps the signature. The header's width
 * and height are now read before anything is written: more than 4096 pixels
 * per side or 4096 x 2048 in total is refused, as is an animated PNG or a
 * file that is not the PNG or JPEG its data URL declares.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sigdim-'));
process.env.STORAGE_PATH = tmpRoot;

const { persistSignatureImage } = require('../../src/services/contract/signatureAssets');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A uniform 1-bit grayscale PNG: tiny on disk whatever its declared size. */
function flatPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; ihdr[9] = 0;
  const row = Buffer.alloc(1 + Math.ceil(width / 8));
  const raw = Buffer.alloc(row.length * height); // zeros: filter 0, black pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (kind, bytes) => `data:image/${kind};base64,${bytes.toString('base64')}`;
const contract = { id: 9001 };
const storedCount = () => {
  const dir = path.join(tmpRoot, 'business-docs', 'contract', 'signatures', '9001');
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
};

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe('signature image dimensions', () => {
  it('stores an ordinary signature PNG and JPEG unchanged', async () => {
    const png = await sharp({ create: { width: 600, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const pngPath = await persistSignatureImage(contract, 'customer', dataUrl('png', png));
    expect(fs.readFileSync(pngPath).equals(png)).toBe(true);

    const jpeg = await sharp({ create: { width: 1800, height: 600, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const jpegPath = await persistSignatureImage(contract, 'admin', dataUrl('jpeg', jpeg));
    expect(fs.readFileSync(jpegPath).equals(jpeg)).toBe(true);
  });

  it('accepts a PNG at the per-side and total limits', async () => {
    await expect(persistSignatureImage(contract, 'customer', dataUrl('png', flatPng(4096, 2048)))).resolves.toEqual(expect.any(String));
  });

  it.each([
    ['too wide', 8000, 100],
    ['too many pixels in total', 4096, 4096],
    ['a large declared raster', 12000, 12000],
  ])('refuses a PNG that is %s', async (_label, width, height) => {
    const png = flatPng(width, height);
    expect(png.length).toBeLessThan(1024 * 1024);
    const before = storedCount();
    await expect(persistSignatureImage(contract, 'customer', dataUrl('png', png)))
      .rejects.toMatchObject({ statusCode: 413, code: 'SIGNATURE_TOO_LARGE' });
    expect(storedCount()).toBe(before);
  });

  it('refuses a JPEG wider than the limit', async () => {
    const jpeg = await sharp({ create: { width: 5000, height: 8, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    await expect(persistSignatureImage(contract, 'customer', dataUrl('jpeg', jpeg)))
      .rejects.toMatchObject({ statusCode: 413, code: 'SIGNATURE_TOO_LARGE' });
  });

  it('refuses an animated PNG, whose frames the header does not bound', async () => {
    const still = flatPng(1, 1);
    const actl = Buffer.alloc(8); actl.writeUInt32BE(1, 0);
    const fctl = Buffer.alloc(26); fctl.writeUInt32BE(0, 0); fctl.writeUInt32BE(20000, 4); fctl.writeUInt32BE(20000, 8);
    // Signature + IHDR (33 bytes), then the animation chunks, then the rest.
    const animated = Buffer.concat([still.subarray(0, 33), chunk('acTL', actl), chunk('fcTL', fctl), still.subarray(33)]);
    await expect(persistSignatureImage(contract, 'customer', dataUrl('png', animated)))
      .rejects.toMatchObject({ statusCode: 400, code: 'BAD_SIGNATURE_FORMAT' });
  });

  it('refuses bytes that are not the declared image kind', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    await expect(persistSignatureImage(contract, 'customer', dataUrl('png', jpeg)))
      .rejects.toMatchObject({ statusCode: 400, code: 'BAD_SIGNATURE_FORMAT' });
    await expect(persistSignatureImage(contract, 'customer', 'data:image/png;base64,YmFk'))
      .rejects.toMatchObject({ statusCode: 400, code: 'BAD_SIGNATURE_FORMAT' });
  });
});
