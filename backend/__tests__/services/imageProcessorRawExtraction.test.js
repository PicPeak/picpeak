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
 *
 * Two more portrait files were run through the real extraction to check that
 * the orientation write cannot turn an upright photo on its side, because the
 * Sony alone does not settle it:
 *
 *   Adobe Lightroom 9.6 DNG off a Sony ILCE-1, container Orientation 8. Its
 *   one embedded JPEG is 1024x683, the sensor frame's aspect ratio, and
 *   carries no EXIF. The write applies and the photo comes out upright.
 *
 *   Apple ProRAW off an iPhone 17 Pro Max, container Orientation 6. Its one
 *   embedded JPEG is the full 4032x3024 frame and states Orientation 6
 *   itself, so the write is skipped and the photo comes out upright.
 *
 * Both are covered below as shapes rather than fixtures, by "puts the camera
 * orientation on the extracted preview" and "leaves a preview that states its
 * own orientation alone".
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
 * What execFile reports when the deadline fires: the child is killed with the
 * configured signal and there is no exit code. `code` stays unset, which is
 * what keeps a wedged tag from being mistaken for a missing binary.
 */
const killedAtDeadline = (args) => Object.assign(
  new Error(`Command failed: exiftool ${args.join(' ')}`),
  { killed: true, signal: 'SIGKILL' }
);

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

  it('still finds the full-size image when no length tag describes it', async () => {
    // Panasonic RW2's JpgFromRaw, Fuji RAF's PreviewImage and the CR3
    // QuickTime boxes have no length tag, so the probe sees only the screen
    // nail. The full-size JPEG is in the file all the same, and taking the
    // probe's silence for an answer would ship 160x120 as the photo.
    exiftoolWith({
      probe: { ThumbnailLength: 7833, Orientation: 1 },
      previews: {
        '-ThumbnailImage': await jpegOf(160, 120),
        '-JpgFromRaw': await jpegOf(5184, 3888),
      },
    });

    const preview = await extractRawPreview('/tmp/P1000123.RW2');
    try {
      expect((await sharp(preview.path).metadata()).width).toBe(5184);
      expect(extractionTags()).toEqual(['-ThumbnailImage', '-JpgFromRaw']);
    } finally {
      await preview.cleanup();
    }
  });

  it('puts the camera orientation on the extracted preview', async () => {
    // Verified on a real ARW: the container says 8, and all three embedded
    // images come out with no EXIF at all. Without this the downstream
    // .rotate() has nothing to act on and every portrait RAW is sideways.
    //
    // Also the Lightroom DNG shape, verified on an Adobe Lightroom 9.6 export
    // off a Sony ILCE-1: container Orientation 8, and the one embedded JPEG is
    // 1024x683, still in the sensor frame and carrying no EXIF of its own.
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
    //
    // This is the Apple ProRAW shape, verified on an iPhone 17 Pro Max file:
    // container Orientation 6, and the embedded 4032x3024 JPEG carries
    // Orientation 6 of its own.
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

  it('removes the temp dir when the fallback write fails', async () => {
    // The fallback is the one write with nothing left to hand back, so there
    // is no cleanup() for the caller to run and a full disk would otherwise
    // leave a directory behind per bad file.
    const fs = require('fs');
    const fsp = fs.promises;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const thumbnail = await jpegOf(160, 120);

    let outDir;
    const realMkdtemp = fsp.mkdtemp.bind(fsp);
    jest.spyOn(fsp, 'mkdtemp').mockImplementation(async (prefix) => {
      outDir = await realMkdtemp(prefix);
      return outDir;
    });
    const realWriteFile = fsp.writeFile.bind(fsp);
    let writes = 0;
    jest.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => {
      writes += 1;
      // The first write is the loop measuring the candidate; the second is
      // the fallback committing it.
      if (writes === 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return realWriteFile(...args);
    });

    try {
      exiftoolWith({
        probe: { ThumbnailLength: 7833, Orientation: 1 },
        previews: { '-ThumbnailImage': thumbnail },
      });

      await expect(extractRawPreview('/tmp/DSC00632.ARW'))
        .rejects.toThrow(/no space left on device/);
      expect(outDir).toBeTruthy();
      expect(fs.existsSync(outDir)).toBe(false);
    } finally {
      jest.restoreAllMocks();
      warn.mockRestore();
    }
  });

  it('moves to the next candidate when one extraction is killed at the deadline', async () => {
    // A single wedged tag must not cost the photo. The largest candidate is
    // the one that hangs, so the fallback is a real downgrade in size and the
    // test would not pass by accident.
    execFile.mockImplementation((cmd, args, options, callback) => {
      if (args.includes('-json')) {
        return process.nextTick(() => callback(null, {
          stdout: JSON.stringify([{ SourceFile: args[args.length - 1], ...ILCE_7M5 }]),
          stderr: '',
        }));
      }
      if (args.some(arg => arg.startsWith('-Orientation='))) {
        return process.nextTick(() => callback(null, { stdout: '1 image files updated', stderr: '' }));
      }
      if (tagOf(args) === '-JpgFromRaw') {
        return process.nextTick(() => callback(killedAtDeadline(args)));
      }
      return process.nextTick(async () => callback(null, {
        stdout: tagOf(args) === '-PreviewImage' ? await jpegOf(1616, 1080) : Buffer.alloc(0),
        stderr: '',
      }));
    });

    const preview = await extractRawPreview('/tmp/DSC00632.ARW');
    try {
      expect((await sharp(preview.path).metadata()).width).toBe(1616);
      expect(extractionTags()).toEqual(['-JpgFromRaw', '-PreviewImage']);
    } finally {
      await preview.cleanup();
    }
  });

  it('reports the deadline when every extraction is killed at it', async () => {
    // The photo fails, and the reason it failed has to reach the log. A
    // timeout swallowed into "no preview tag returned data" sends whoever
    // reads it looking for a corrupt file.
    execFile.mockImplementation((cmd, args, options, callback) => {
      if (args.includes('-json')) {
        return process.nextTick(() => callback(null, {
          stdout: JSON.stringify([{ SourceFile: args[args.length - 1], ...ILCE_7M5 }]),
          stderr: '',
        }));
      }
      return process.nextTick(() => callback(killedAtDeadline(args)));
    });

    await expect(extractRawPreview('/tmp/DSC00632.ARW'))
      .rejects.toThrow(/No usable embedded preview in RAW file DSC00632.ARW: Command failed/);
    // Every tag is still tried: unlike a missing binary, one tag timing out
    // says nothing about the next.
    expect(extractionTags()).toEqual(['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage']);
  });

  it('fails when the file carries no embedded image at all', async () => {
    exiftoolWith({ probe: { Orientation: 1 } });
    await expect(extractRawPreview('/tmp/DSC00632.ARW'))
      .rejects.toThrow(/No usable embedded preview/);
    // Every tag is asked, because a silent probe is not the same answer as an
    // empty file: three formats carry a full-size JPEG under no length tag.
    // Each miss is one spawn that writes nothing.
    expect(extractionTags()).toEqual(['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage']);
  });
});
