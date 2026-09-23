'use strict';

const fs = require('fs');
const path = require('path');

const regular = fs.readFileSync(path.resolve(__dirname, '../../assets/fonts/Jost/400.ttf'));

describe('fontValidation without a worker', () => {
  afterEach(() => {
    jest.dontMock('worker_threads');
    jest.dontMock('../../src/utils/fontInspect');
  });

  it('refuses rather than parsing the font in the main thread', async () => {
    jest.resetModules();
    jest.doMock('worker_threads', () => ({ Worker: function NoWorker() { throw new Error('no workers here'); } }));
    const actual = jest.requireActual('../../src/utils/fontInspect');
    const inspectFont = jest.fn(actual.inspectFont);
    jest.doMock('../../src/utils/fontInspect', () => ({ ...actual, inspectFont }));
    const { validateFont } = require('../../src/utils/fontValidation');
    const err = await validateFont(regular).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('DOCUMENT_CHECK_UNAVAILABLE');
    expect(inspectFont).not.toHaveBeenCalled();
  });
});

describe('fontInspect embedding licence', () => {
  // Rename the OS/2 directory entry so fontkit sees no such table.
  const withoutOs2 = (buffer) => {
    const copy = Buffer.from(buffer);
    for (let i = 0; i < copy.readUInt16BE(4); i += 1) {
      const at = 12 + 16 * i;
      if (copy.toString('latin1', at, at + 4) === 'OS/2') copy.write('XS/2', at, 'latin1');
    }
    return copy;
  };

  it('reads fsType from a real font, and accepts a font that declares no restriction (no OS/2 table)', () => {
    const { inspectFont } = jest.requireActual('../../src/utils/fontInspect');
    const fontkit = require('fontkit');
    expect(fontkit.create(regular)['OS/2'].fsType).toEqual(expect.objectContaining({ noEmbedding: false }));
    const stripped = withoutOs2(regular);
    expect(fontkit.create(stripped)['OS/2']).toBeUndefined();
    expect(inspectFont(stripped).format).toBe('ttf');
  });
});
