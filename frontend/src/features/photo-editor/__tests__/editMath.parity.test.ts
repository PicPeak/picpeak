/**
 * The browser's copy of the edit math (issue 2619) is pinned to the same
 * fixtures as the server's (backend/__tests__/utils/photoEditMath.test.js),
 * so the preview and the saved photo cannot drift apart unnoticed.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import * as math from '../editMath';

const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), '../backend/__tests__/fixtures/photoEditMath.fixtures.json'), 'utf8'));

const deepClose = (actual: unknown, expected: unknown): void => {
  if (typeof expected === 'number') { expect(actual as number).toBeCloseTo(expected, 9); return; }
  if (Array.isArray(expected)) { expected.forEach((v, i) => deepClose((actual as unknown[])[i], v)); return; }
  if (expected && typeof expected === 'object') {
    Object.keys(expected).forEach((k) => deepClose((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k]));
    return;
  }
  expect(actual).toEqual(expected);
};

describe('editMath matches the server fixtures', () => {
  const prepFields = (p: math.Prepared) => ({ matrix: p.matrix, gamma: p.gamma, whiteLevel: p.whiteLevel, blackLevel: p.blackLevel, shoulder: p.shoulder, baseline: p.baseline });
  it.each(fixtures.cases.map((c: { name: string }) => [c.name, c]))('%s', (_name, c) => {
    const params = c.params as math.EditParams;
    deepClose(prepFields(math.prepare(params)), c.prep);
    deepClose(prepFields(math.prepare(params, { linear: true, exposureBias: 1 })), c.prepRaw);
    deepClose([0, 0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.98, 1].map((x) => math.referencePixel([x, x, x], params)), c.grey);
    for (const p of c.pixels) {
      deepClose(math.referencePixel(p.in, params), p.out);
      deepClose(math.referencePixel(p.in, params, { dc: 0.3, ds: -0.1 }), p.detail);
      deepClose(math.referencePixel(p.in, params, { linear: true, exposureBias: 1 }), p.raw);
    }
    deepClose(math.effectiveCrop(params, 600, 400), c.crop);
    deepClose(math.outputSize(params, 600, 400, { maxPixels: 100000 }), c.output);
    for (const p of c.points) deepClose(math.mapPointToEdited(params, 600, 400, p.in), p.out);
    expect(math.isIdentity(params)).toBe(c.name === 'identity');
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
    deepClose(math.detailSigmas(fixtures.sigmas.in[0], fixtures.sigmas.in[1]), fixtures.sigmas.out);
  });

  it('blurs like the server, and keeps a constant plane constant', () => {
    const { width, height, sigma } = fixtures.blur;
    const plane = Int16Array.from(fixtures.blur.in);
    math.blurPlane(plane, new Int16Array(plane.length), width, height, sigma);
    expect(Array.from(plane)).toEqual(fixtures.blur.out);
    const flat = new Int16Array(40 * 3).fill(-2048);
    math.blurPlane(flat, new Int16Array(flat.length), 40, 3, 1);
    expect(Array.from(flat).every((v) => v === -2048)).toBe(true);
  });

  it('the shader map is the inverse map as a matrix', () => {
    const params = fixtures.cases.find((c: { name: string }) => c.name === 'mixed').params as math.EditParams;
    const out = math.outputSize(params, 600, 400);
    const map = math.inverseMapper(params, 600, 400, out);
    const m = math.inverseAffine(params, 600, 400, out);
    for (const [x, y] of [[0.5, 0.5], [100, 30], [out.width - 1, out.height - 2]]) {
      const p = map(x, y);
      expect(m[0] * x + m[1] * y + m[2]).toBeCloseTo(p.x, 6);
      expect(m[3] * x + m[4] * y + m[5]).toBeCloseTo(p.y, 6);
    }
  });
});
