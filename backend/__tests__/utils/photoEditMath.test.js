/**
 * The photo editor's math (issue 2619). Pins:
 *  - the module still produces the shared fixtures, which the browser's copy
 *    (frontend editMath.ts) is pinned to as well
 *  - a JPEG with no edit is unchanged; the RAW look puts grey and white where
 *    the spec says; every tone slider keeps the tones in order; sliders go
 *    the way they are labelled; no channel goes negative or past white
 *  - the server's pixel pass (tables, two passes) matches the formulas within
 *    a level, for 8-bit and 16-bit linear input
 *  - geometry: the crop never leaves the straightened image, points map
 *    there and back, output sizes stay bounded
 */
const math = require('../../src/utils/photoEditMath');
const fixtures = require('../fixtures/photoEditMath.fixtures.json');

const close = (a, b) => expect(a).toBeCloseTo(b, 9);
const deepClose = (actual, expected) => {
  if (typeof expected === 'number') return close(actual, expected);
  if (Array.isArray(expected)) return expected.forEach((v, i) => deepClose(actual[i], v));
  if (expected && typeof expected === 'object') return Object.keys(expected).forEach((k) => deepClose(actual[k], expected[k]));
  return expect(actual).toEqual(expected);
};

describe('shared fixtures', () => {
  const prepFields = (p) => ({ matrix: p.matrix, gamma: p.gamma, whiteLevel: p.whiteLevel, blackLevel: p.blackLevel, shoulder: p.shoulder, baseline: p.baseline });
  it.each(fixtures.cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    expect(math.validateEditParams(c.params)).toEqual({ params: c.params });
    deepClose(prepFields(math.prepare(c.params)), c.prep);
    deepClose(prepFields(math.prepare(c.params, { linear: true, exposureBias: 1 })), c.prepRaw);
    deepClose([0, 0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.98, 1].map((x) => math.referencePixel([x, x, x], c.params)), c.grey);
    for (const p of c.pixels) {
      deepClose(math.referencePixel(p.in, c.params), p.out);
      deepClose(math.referencePixel(p.in, c.params, { dc: 0.3, ds: -0.1 }), p.detail);
      deepClose(math.referencePixel(p.in, c.params, { linear: true, exposureBias: 1 }), p.raw);
    }
    deepClose(math.effectiveCrop(c.params, 600, 400), c.crop);
    deepClose(math.outputSize(c.params, 600, 400, { maxPixels: 100000 }), c.output);
    for (const p of c.points) deepClose(math.mapPointToEdited(c.params, 600, 400, p.in), p.out);
  });

  it('white balance, sigmoid, auto tone, statistics, blur boxes and radii', () => {
    deepClose(math.fitSigmoid(), fixtures.sigmoid);
    for (const { in: [t, n], out } of fixtures.whiteBalance) deepClose(math.whiteBalanceMatrix(t, n), out);
    for (const { stats, out, raw } of fixtures.autoTone) {
      expect(math.autoTone(stats)).toEqual(out);
      expect(math.autoTone(stats, { linear: true })).toEqual(raw);
    }
    deepClose(math.toneStats(fixtures.toneStats.in), fixtures.toneStats.out);
    for (const { sigma, out } of fixtures.boxes) expect(math.boxesForGauss(sigma)).toEqual(out);
    deepClose(math.detailSigmas(...fixtures.sigmas.in), fixtures.sigmas.out);
  });
});

describe('look and guarantees', () => {
  const grey = (params, x, options) => math.referencePixel([x, x, x], params, options)[1];

  it('a JPEG with no edit is unchanged, to the 8-bit level', () => {
    for (let v = 0; v <= 255; v++) {
      const out = math.referencePixel([v / 255, (255 - v) / 255, ((v * 7) % 256) / 255], math.DEFAULT_PARAMS);
      expect(out.map((c) => Math.round(c * 255))).toEqual([v, 255 - v, (v * 7) % 256]);
    }
  });

  it('the RAW look: middle grey near 119 after the baseline, clipping white below 255, black near 0', () => {
    const raw = { ...math.DEFAULT_PARAMS, develop: true };
    const middle = math.G0 / 2 ** math.RAW_BASELINE_EV;
    expect(Math.round(grey(raw, middle, { linear: true }) * 255)).toBe(119);
    expect(Math.round(grey(raw, 1, { linear: true }) * 255)).toBeLessThan(250);
    expect(Math.round(grey(raw, 0, { linear: true }) * 255)).toBeLessThanOrEqual(2);
  });

  it.each(['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'exposure', 'clarity'].flatMap((key) => [
    [key, -100, false], [key, 100, false], [key, -100, true], [key, 100, true],
  ]))('keeps the tones in order with %s at %d (RAW: %s)', (key, value, linear) => {
    const params = { ...math.DEFAULT_PARAMS, [key]: key === 'exposure' ? value / 20 : value };
    const prep = math.prepare(params, { linear });
    let previous = -1;
    for (let i = 0; i <= 1000; i++) {
      const x = i / 1000;
      const o = math.referencePixel([x, x, x], params, { linear, prep });
      const y = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2];
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });

  it('the sliders go the way they say', () => {
    const p = math.DEFAULT_PARAMS;
    expect(grey({ ...p, highlights: -60 }, 0.8)).toBeLessThan(0.8);
    expect(grey({ ...p, shadows: 60 }, 0.1)).toBeGreaterThan(0.1);
    expect(grey({ ...p, whites: 60 }, 0.8)).toBeGreaterThan(0.8);
    expect(grey({ ...p, blacks: -60 }, 0.05)).toBeLessThan(0.05);
    const warm = math.referencePixel([0.5, 0.5, 0.5], { ...p, temperature: 50 });
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const magenta = math.referencePixel([0.5, 0.5, 0.5], { ...p, tint: 50 });
    expect(magenta[1]).toBeLessThan(magenta[0]);
  });

  it('never makes a negative channel, and pushes past-white values under a shoulder', () => {
    const p = { ...math.DEFAULT_PARAMS, saturation: 100, vibrance: 100, temperature: -100, exposure: 2 };
    for (const rgb of [[0.9, 0.05, 0.02], [0.02, 0.9, 0.05], [1, 1, 1], [0.3, 0.3, 0.9]]) {
      const out = math.referencePixel(rgb, p);
      for (const c of out) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
    expect(math.prepare(p).shoulder).toBeGreaterThan(1);
  });
});

describe('server pixel pass vs the formulas', () => {
  const card = (width, height, max = 255) => {
    const data = max > 255 ? new Uint16Array(width * height * 3) : Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      data[i * 3] = Math.round(((i * 7) % 256) / 255 * max);
      data[i * 3 + 1] = Math.round(((i * 13 + 40) % 256) / 255 * max);
      data[i * 3 + 2] = Math.round(((i * 29 + 90) % 256) / 255 * max);
    }
    return data;
  };

  it('identity is an exact copy', () => {
    const src = card(64, 48);
    expect(math.renderEdit(src, 64, 48, 3, math.DEFAULT_PARAMS).data.equals(src)).toBe(true);
  });

  it.each(fixtures.cases.filter((c) => !math.hasGeometry(c.params)).map((c) => [c.name, c.params]))(
    'within a level of the formulas without detail: %s', (_name, input) => {
      const params = { ...input, clarity: 0, sharpen: 0, shadows: 0, highlights: 0, whites: 0, blacks: 0 };
      for (const linear of [false, true]) {
        const src = card(64, 48, linear ? 65535 : 255);
        const out = math.renderEdit(src, 64, 48, 3, params, { linear }).data;
        const scale = linear ? 65535 : 255;
        let worst = 0;
        for (let i = 0; i < 64 * 48; i++) {
          const ref = math.referencePixel([src[i * 3] / scale, src[i * 3 + 1] / scale, src[i * 3 + 2] / scale], params, { linear });
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[i * 3 + c] - ref[c] * 255));
        }
        expect(worst).toBeLessThanOrEqual(1);
      }
    },
  );
});

describe('geometry', () => {
  it('keeps every corner of the effective crop on the straightened image', () => {
    for (const straighten of [-45, -12.5, -1, 1, 7, 30, 45]) {
      for (const rotate of [0, 90]) {
        const params = { ...math.DEFAULT_PARAMS, rotate, straighten, crop: { x: 0.05, y: 0.1, w: 0.9, h: 0.6 } };
        const out = math.outputSize(params, 900, 600);
        const map = math.inverseMapper(params, 900, 600, out);
        for (const [x, y] of [[0, 0], [out.width, 0], [0, out.height], [out.width, out.height]]) {
          const p = map(x, y);
          expect(p.x).toBeGreaterThanOrEqual(-0.5);
          expect(p.x).toBeLessThanOrEqual(900.5);
          expect(p.y).toBeGreaterThanOrEqual(-0.5);
          expect(p.y).toBeLessThanOrEqual(600.5);
        }
      }
    }
  });

  it('maps points to the edit and back', () => {
    const params = math.validateEditParams({ rotate: 270, flipH: true, straighten: -4, crop: { x: 0.2, y: 0.1, w: 0.5, h: 0.7 } }).params;
    for (const point of [{ x: 0.3, y: 0.4 }, { x: 0.5, y: 0.5 }, { x: 0.45, y: 0.6 }]) {
      const back = math.mapPointFromEdited(params, 1200, 800, math.mapPointToEdited(params, 1200, 800, point));
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
    }
  });

  it('bounds the output: never larger than the source nor the cap, never empty', () => {
    const tiny = math.validateEditParams({ crop: { x: 0, y: 0, w: 0.02, h: 0.02 } }).params;
    expect(math.outputSize(tiny, 40, 40)).toMatchObject({ width: 1, height: 1 });
    const whole = math.outputSize(math.DEFAULT_PARAMS, 12000, 9000, { maxPixels: 36e6 });
    expect(whole.width * whole.height).toBeLessThanOrEqual(36e6 + 12000);
    expect(math.outputSize({ ...math.DEFAULT_PARAMS, straighten: 45 }, 6000, 4000).width).toBeLessThanOrEqual(6000);
  });
});

describe('validation', () => {
  it('normalises: rounds, drops a whole-frame crop, stores identity as no edit', () => {
    const { params } = math.validateEditParams({ exposure: 0.123456, contrast: 10.6, crop: { x: 0, y: 0, w: 1, h: 1 } });
    expect(params).toMatchObject({ exposure: 0.12, contrast: 11, crop: null });
    expect(math.isIdentity(math.validateEditParams({ exposure: -0.001 }).params)).toBe(true);
    expect(math.parseStoredParams('{"v":1}')).toBeNull();
    expect(math.parseStoredParams('{"v":1,"exposure":1}')).toMatchObject({ exposure: 1 });
    expect(math.parseStoredParams('not json')).toBeNull();
    expect(math.parseStoredParams('{"exposure":99}')).toBeNull();
  });

  it.each([
    [null], [[]], [{ crop: [0, 0, 1, 1] }], [{ crop: { x: 0, y: 0, w: 1, h: 1, z: 1 } }], [{ exposure: Number.NaN }],
    [{ exposure: Infinity }], [{ flipH: 1 }], [{ rotate: '90' }], [{ __proto__: { exposure: 1 }, foo: 1 }],
  ])('refuses %j', (input) => {
    expect(math.validateEditParams(input).error).toBeTruthy();
  });
});
