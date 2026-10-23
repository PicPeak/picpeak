const priceRules = require('../priceRules');

describe('photo sales pricing rules', () => {
  it('treats non-priced galleries as unchanged', () => {
    expect(priceRules.isGalleryPriced({ is_priced: false })).toBe(false);
    expect(priceRules.shouldForceWatermarkForPhoto({ is_priced: false }, { id: 1 })).toBe(false);
  });

  it('forces the watermark on EVERY photo of a priced gallery before checkout', () => {
    const event = { is_priced: true, free_photo_count: 2 };
    // The free quota is decided per ORDER, so no single photo is known to
    // be free in advance — all of them carry the forced mark.
    expect(priceRules.shouldForceWatermarkForPhoto(event, { id: 10 })).toBe(true);
    expect(priceRules.shouldForceWatermarkForPhoto(event, { id: 99 })).toBe(true);
  });

  it('allocates the first N order lines as free, the rest at the gallery price', () => {
    const event = { is_priced: true, free_photo_count: 2, photo_price: 0.24 };
    const lines = priceRules.allocateFreeLines(event, [
      { photoId: 11 },
      { photoId: 12 },
      { photoId: 13 },
    ]);
    expect(lines.map((line) => line.free)).toEqual([true, true, false]);
    expect(lines.map((line) => line.amountCents)).toEqual([0, 0, 24]);
  });

  it('honours per-photo price overrides on paid lines', () => {
    const event = { is_priced: true, free_photo_count: 1, photo_price: 0.24 };
    const lines = priceRules.allocateFreeLines(event, [
      { photoId: 11 },
      { photoId: 12, photo_price: 0.5 },
    ]);
    expect(lines[0]).toMatchObject({ free: true, amountCents: 0 });
    expect(lines[1]).toMatchObject({ free: false, amountCents: 50 });
  });

  it('a priced gallery with zero free photos charges every line', () => {
    const event = { is_priced: true, free_photo_count: 0, photo_price: 0.24 };
    const lines = priceRules.allocateFreeLines(event, [{ photoId: 11 }, { photoId: 12 }]);
    expect(lines.every((line) => !line.free && line.amountCents === 24)).toBe(true);
  });
});
