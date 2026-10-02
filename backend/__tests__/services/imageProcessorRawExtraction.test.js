/**
 * The exiftool side of RAW extraction, with exiftool mocked.
 *
 * exiftool is not a dev dependency and there is no RAW fixture in the repo, so
 * the real thing can only be exercised by hand. What is pinned here is
 * everything around the subprocess: that the file itself decides which
 * embedded image is used, that a 160x120 screen nail cannot become the photo,
 * that the camera's orientation reaches the extracted preview, and the limits
 * each spawn runs under.
 *
 * The numbers come from a real Sony ILCE-7M5 ARW: a 7008x4672 JpgFromRaw at
 * 2393931 bytes, a 1616x1080 PreviewImage at 285137, a 160x120 ThumbnailImage
 * at 7833, and Orientation 8 on the container with no EXIF on any of the three
 * extracted images.
 */
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

const sharp = require('sharp');
const { execFile } = require('child_process');
const { extractRawPreview } = require('../../src/services/imageProcessor');
const logger = require('../../src/utils/logger');

const ILCE_7M5 = {
  JpgFromRawLength: 2393931,
  PreviewImageLength: 285137,
  ThumbnailLength: 7833,
  Orientation: 8,
};

const jpegOf = (width, height) => sharp({
  create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
}).jpeg().toBuffer();

const tagOf = (args) => args.find(arg => arg.startsWith('-') && arg !== '-b' && arg !== '-n');

/**
 * Stand in for exiftool: answer the probe from `probe`, answer each `-b <tag>`
 * from `previews`, and accept an orientation write. A tag the file does not
 * carry writes nothing to stdout rather than failing, which is what exiftool
 * really does (verified: exit 0, zero bytes).
 */
const exiftoolWith = ({ probe = {}, previews = {} } = {}) => {
  const orientationWrites = [];
  execFile.mockImplementation((cmd, args, options, callback) => {
    const done = (value) => process.nextTick(() => callback(null, value));

    if (args.includes('-json')) {
      return done({ stdout: JSON.stringify([{ SourceFile: args[args.length - 1], ...probe }]), stderr: '' });
    }
    const write = args.find(arg => arg.startsWith('-Orientation='));
    if (write) {
      orientationWrites.push(Number(write.split('=')[1]));
      return done({ stdout: '1 image files updated', stderr: '' });
    }
    return done({ stdout: previews[tagOf(args)] || Buffer.alloc(0), stderr: '' });
  });
  return orientationWrites;
};

const extractionTags = () => execFile.mock.calls
  .filter(([, args]) => args.includes('-b'))
  .map(([, args]) => tagOf(args));

beforeEach(() => {
  execFile.mockReset();
});

describe('extractRawPreview', () => {
  it('takes the largest embedded image, not the first one it can name', async () => {
    // The whole point. A fixed tag order would have taken PreviewImage here
    // and capped a 36.7 MP photo at 1.7 MP.
    exiftoolWith({
      probe: ILCE_7M5,
      previews: {
        '-JpgFromRaw': await jpegOf(7008, 4672),
        '-PreviewImage': await jpegOf(1616, 1080),
        '-ThumbnailImage': await jpegOf(160, 120),
      },
    });

    const preview = await extractRawPreview('/tmp/DSC00632.ARW');
    try {
      expect(extractionTags()).toEqual(['-JpgFromRaw']);
      expect((await sharp(preview.path).metadata()).width).toBe(7008);
    } finally {
      await preview.cleanup();
    }
  });

  it('takes PreviewImage on a body that embeds no JpgFromRaw', async () => {
    // Older Sony bodies. One probe, one extraction, nothing wasted.
    exiftoolWith({
      probe: { PreviewImageLength: 285137, ThumbnailLength: 7833, Orientation: 1 },
      previews: {
        '-PreviewImage': await jpegOf(1616, 1080),
        '-ThumbnailImage': await jpegOf(160, 120),
      },
    });

    const preview = await extractRawPreview('/tmp/DSC00001.ARW');
    try {
      expect(extractionTags()).toEqual(['-PreviewImage']);
      expect((await sharp(preview.path).metadata()).width).toBe(1616);
    } finally {
      await preview.cleanup();
    }
  });

  it('puts the camera orientation on the extracted preview', async () => {
    // Verified on a real ARW: the container says 8, and all three embedded
    // images come out with no EXIF at all. Without this the downstream
    // .rotate() has nothing to act on and every portrait RAW is sideways.
    const writes = exiftoolWith({
      probe: ILCE_7M5,
      previews: { '-JpgFromRaw': await jpegOf(7008, 4672) },
    });

    const preview = await extractRawPreview('/tmp/DSC00632.ARW');
    try {
      expect(writes).toEqual([8]);
    } finally {
      await preview.cleanup();
    }
  });

  it('leaves a preview that states its own orientation alone', async () => {
    // Sony's states nothing, but this runs for seventeen formats. Where a
    // preview does carry the tag it describes its own pixels, and the
    // container's value may contradict it — overwriting would rotate a photo
    // that was already upright.
    const selfDescribing = await sharp({
      create: { width: 6000, height: 4000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).withMetadata({ orientation: 1 }).jpeg().toBuffer();
    const writes = exiftoolWith({
      probe: { JpgFromRawLength: 2393931, Orientation: 8 },
      previews: { '-JpgFromRaw': selfDescribing },
    });

    const preview = await extractRawPreview('/tmp/other-vendor.NEF');
    try {
      expect(writes).toEqual([]);
      expect((await sharp(preview.path).metadata()).orientation).toBe(1);
    } finally {
      await preview.cleanup();
    }
  });

  it('does not spend a spawn writing an orientation that means nothing', async () => {
    const writes = exiftoolWith({
      probe: { JpgFromRawLength: 2393931, Orientation: 1 },
      previews: { '-JpgFromRaw': await jpegOf(7008, 4672) },
    });

    const preview = await extractRawPreview('/tmp/landscape.ARW');
    try {
      expect(writes).toEqual([]);
    } finally {
      await preview.cleanup();
    }
  });

  it('rejects a screen thumbnail that the byte lengths ranked first', async () => {
    // Bytes rank the candidates, pixels decide whether one is acceptable. A
    // preview that is small on disk AND small in pixels must not become the
    // photo just because it was the biggest thing in the file.
    exiftoolWith({
      probe: { ThumbnailLength: 7833, PreviewImageLength: 285137, Orientation: 1 },
      previews: {
        '-ThumbnailImage': await jpegOf(160, 120),
        '-PreviewImage': await jpegOf(1616, 1080),
      },
    });

    const preview = await extractRawPreview('/tmp/DSC00001.ARW');
    try {
      expect((await sharp(preview.path).metadata()).width).toBe(1616);
    } finally {
      await preview.cleanup();
    }
  });

  it('uses a screen thumbnail only as a last resort, and says so', async () => {
    // Some bodies write an empty PreviewImage — exiftool documents the
    // ILCE-5100, 7M2, 7RM2 and 7SM2. A visible-but-soft photo beats a photo
    // the client cannot see at all, but it must not happen silently.
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    exiftoolWith({
      probe: { ThumbnailLength: 7833, Orientation: 1 },
      previews: { '-ThumbnailImage': await jpegOf(160, 120) },
    });

    const preview = await extractRawPreview('/tmp/DSC09999.ARW');
    try {
      expect((await sharp(preview.path).metadata()).width).toBe(160);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DSC09999.ARW'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('160x120'));
    } finally {
      await preview.cleanup();
      warn.mockRestore();
    }
  });

  it('gives every spawn a deadline and a bounded buffer', async () => {
    exiftoolWith({
      probe: ILCE_7M5,
      previews: { '-JpgFromRaw': await jpegOf(7008, 4672) },
    });

    const preview = await extractRawPreview('/tmp/DSC00632.ARW');
    try {
      expect(execFile.mock.calls.length).toBeGreaterThan(0);
      for (const [, , options] of execFile.mock.calls) {
        // Without these a wedged exiftool holds its worker slot until the
        // janitor resets the row, and the next worker wedges on the same file.
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.killSignal).toBe('SIGKILL');
        expect(options.maxBuffer).toBeLessThanOrEqual(64 * 1024 * 1024);
      }
    } finally {
      await preview.cleanup();
    }
  });

  it('falls back to trying every tag when the probe itself fails', async () => {
    // The probe is the fussier of the two calls. An extraction that would have
    // worked should not be lost to it.
    execFile.mockImplementation((cmd, args, options, callback) => {
      if (args.includes('-json')) {
        return process.nextTick(() => callback(new Error('Unknown tag')));
      }
      const previews = { '-PreviewImage': null };
      process.nextTick(async () => {
        callback(null, {
          stdout: tagOf(args) === '-JpgFromRaw' ? await jpegOf(6000, 4000) : Buffer.alloc(0),
          stderr: '',
        });
      });
      return previews;
    });

    const preview = await extractRawPreview('/tmp/IMG_0001.DNG');
    try {
      expect((await sharp(preview.path).metadata()).width).toBe(6000);
    } finally {
      await preview.cleanup();
    }
  });

  it('fails with the install instructions when exiftool is missing', async () => {
    const enoent = Object.assign(new Error('spawn exiftool ENOENT'), { code: 'ENOENT' });
    execFile.mockImplementation((cmd, args, options, callback) => {
      process.nextTick(() => callback(enoent));
    });

    await expect(extractRawPreview('/tmp/DSC00632.ARW')).rejects.toThrow(/not installed/);
    // One spawn, not four: a missing binary fails the same way every time.
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('fails when the file carries no embedded image at all', async () => {
    exiftoolWith({ probe: { Orientation: 1 } });
    await expect(extractRawPreview('/tmp/DSC00632.ARW'))
      .rejects.toThrow(/No usable embedded preview/);
    // The probe already said there is nothing, so nothing is extracted.
    expect(extractionTags()).toEqual([]);
  });
});
