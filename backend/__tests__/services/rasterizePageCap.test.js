const rasterizeService = require('../../src/services/rasterizeService');

// The page-range guard runs BEFORE any fs/pdftoppm work, so these reject
// without touching the binary or disk (PR #622 concern 6).
describe('getRenderedPagePath page-range guard', () => {
  it.each([0, -1, 201, 1000, 1.5, NaN])('rejects out-of-range page %p', async (page) => {
    await expect(rasterizeService.getRenderedPagePath(1, '/tmp/does-not-exist.pdf', page))
      .rejects.toMatchObject({ statusCode: 400, code: 'PAGE_OUT_OF_RANGE' });
  });
});
