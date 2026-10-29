'use strict';
const { defineProfile, resolveProfile } = require('../../src/services/printSales/manufacturingProfiles');
const G = require('../../src/services/albumProducts/library');
const V = require('../../src/services/albumProducts/validation');
const { ValidationError, ConflictError } = require('../../src/utils/errors');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = (value) => JSON.parse(JSON.stringify(value));

// Real shared-catalogue validation/resolution; no duplicate product-option logic.
function fixture() {
  const library = G.cleanLibrary([
    { id: id(1), name: 'Size', kind: 'size', options: [
      { id: id(11), name: '10 × 15 cm', width: 10, height: 15, unit: 'cm', active: true },
      { id: id(12), name: '13 × 18 cm', width: 13, height: 18, unit: 'cm', active: true },
    ] },
    { id: id(2), name: 'Finish', kind: 'choice', options: [
      { id: id(21), name: 'Matte', active: true },
      { id: id(22), name: 'Gloss', active: true },
    ] },
    { id: id(3), name: 'Extras', kind: 'choice', options: [
      { id: id(31), name: 'Stand', active: true },
      { id: id(32), name: 'Backing', active: true },
    ] },
    { id: id(4), name: 'Stand colour', kind: 'choice', options: [
      { id: id(41), name: 'Natural', active: true },
    ] },
  ]);
  const attribute = (n, required, multiple = false, dependsOn = []) => ({
    id: id(100 + n), groupId: id(n), name: library[n - 1].name,
    optionIds: library[n - 1].options.map((o) => o.id), required, multiple, dependsOn,
  });
  const types = G.cleanTypes([{
    id: id(200), name: 'Rectangular photo product', active: true,
    attributes: [attribute(1, true), attribute(2, true), attribute(3, false, true),
      attribute(4, true, false, [{ attributeId: id(103), optionIds: [id(31)] }])],
  }], library);
  const products = V.products([{
    id: id(300), name: 'Photographic print', active: true, typeId: id(200),
  }]);
  const catalogue = { products, library, types };
  const selection = {
    productId: id(300), productVersion: G.resolve(products[0], catalogue).version,
    values: { [id(101)]: [id(11)], [id(102)]: [id(21)] },
  };
  const definition = {
    id: id(400), revision: 1, enabled: true, selection: copy(selection),
    labReference: 'Studio A / rectangular product',
    manufacturing: {
      capability: 'single-photo-rectangle',
      trimMm: { width: 101.6, height: 152.4 },
      bleedMm: { top: 2, right: 3, bottom: 4, left: 5 },
      safeInsetMm: { top: 3, right: 3, bottom: 3, left: 3 },
      resolution: { targetDpi: 300, minimumDpi: 150 },
      output: { format: 'jpeg', colourSpace: 'srgb' }, fitModes: ['cover', 'contain'],
    },
  };
  return { catalogue, selection, definition };
}

describe('catalogue-backed rectangular manufacturing profiles', () => {
  let catalogue, selection, definition;
  beforeEach(() => { ({ catalogue, selection, definition } = fixture()); });
  const resolve = () => resolveProfile(catalogue, [definition], selection);

  test('preserves nominal display size separately from trim, bleed and raster dimensions', () => {
    const result = resolve();
    expect(result.selection.attributes[0].options[0]).toMatchObject({ width: 10, height: 15, unit: 'cm' });
    expect(result.manufacturing.trimMm).toEqual({ width: 101.6, height: 152.4 });
    expect(result.artwork).toEqual({ widthMm: 109.6, heightMm: 158.4, widthPx: 1294, heightPx: 1871 });
    expect(result.version).toMatch(/^[a-f0-9]{64}$/);
  });

  test('two studios use different production geometry without changing catalogue sizes', () => {
    const other = copy(definition);
    other.labReference = 'Studio B / flat print';
    other.supplierName = 'Supplier selected by the second studio';
    other.instructions = 'Use our stock code.\nCheck our packaging instructions.';
    other.manufacturing.output = { format: 'tiff', colourSpace: 'srgb', compression: 'lzw' };
    other.manufacturing.background = '#000000';
    other.manufacturing.trimMm = { width: 100, height: 150 };
    other.manufacturing.bleedMm = { top: 0, right: 0, bottom: 0, left: 0 };
    const first = resolve(), second = resolveProfile(catalogue, [other], selection);
    expect(second.artwork).toEqual({ widthMm: 100, heightMm: 150, widthPx: 1181, heightPx: 1772 });
    expect(second.selection).toEqual(first.selection);
    expect(first.manufacturing.output.format).toBe('jpeg');
    expect(second.manufacturing.output).toMatchObject({ format: 'tiff', compression: 'lzw' });
    expect(second.supplierName).toBe('Supplier selected by the second studio');
    expect(second.instructions).toContain('\nCheck our packaging instructions.');
    expect(second.version).not.toBe(first.version);
  });

  test.each([101, 102])('has no fallback for an unconfigured size/finish (%s)', (attribute) => {
    selection.values[id(attribute)] = [id(attribute === 101 ? 12 : 22)];
    expect(resolve).toThrow(ConflictError);
  });

  test('additional selected options do not match a less-specific profile', () => {
    selection.values[id(103)] = [id(32)];
    expect(resolve).toThrow(ConflictError);
  });

  test('explicit empty extras and reordered input keys are equivalent', () => {
    const expected = resolve();
    selection.values = { [id(104)]: [], [id(103)]: [], [id(102)]: [id(21)], [id(101)]: [id(11)] };
    expect(resolve()).toEqual(expected);
  });

  test('multi-select option order does not change profile identity', () => {
    definition.selection.values[id(103)] = [id(31), id(32)];
    definition.selection.values[id(104)] = [id(41)];
    selection.values = { ...copy(definition.selection.values), [id(103)]: [id(32), id(31)] };
    expect(resolve()).toEqual(defineProfile(catalogue, definition));
  });

  test('rejects missing dependent choices using shared-library rules', () => {
    selection.values[id(103)] = [id(31)];
    expect(resolve).toThrow('Choose Stand colour');
  });

  test('rejects hidden dependent choices using shared-library rules', () => {
    selection.values[id(104)] = [id(41)];
    expect(resolve).toThrow('depends on another choice');
  });

  test.each(['missing required', 'unknown attribute', 'unknown option', 'duplicate option', 'stale version'])('rejects invalid buyer choices: %s', (kind) => {
    if (kind === 'missing required') delete selection.values[id(101)];
    if (kind === 'unknown attribute') selection.values[id(999)] = [];
    if (kind === 'unknown option') selection.values[id(101)] = [id(999)];
    if (kind === 'duplicate option') selection.values[id(103)] = [id(32), id(32)];
    if (kind === 'stale version') selection.productVersion = 'old';
    expect(resolve).toThrow(ValidationError);
  });

  test.each(['product', 'type', 'option'])('rejects disabled catalogue %s', (kind) => {
    if (kind === 'product') catalogue.products[0].active = false;
    if (kind === 'type') catalogue.types[0].active = false;
    if (kind === 'option') catalogue.library[0].options[0].active = false;
    expect(resolve).toThrow(ValidationError);
  });

  test('requires explicit profile enablement and rejects ambiguity', () => {
    definition.enabled = false;
    expect(resolve).toThrow(ConflictError);
    definition.enabled = true;
    expect(() => resolveProfile(catalogue, [definition, { ...definition, id: id(401) }], selection))
      .toThrow('Multiple manufacturing profiles');
  });

  test('catalogue edits require a re-bound profile for new orders', () => {
    const accepted = resolve(), retained = JSON.stringify(accepted);
    catalogue.library[0].options[0].width = 10.1;
    selection.productVersion = G.resolve(catalogue.products[0], catalogue).version;
    expect(resolve).toThrow('No enabled manufacturing profile');
    expect(JSON.stringify(accepted)).toBe(retained);
    definition.selection.productVersion = selection.productVersion;
    expect(resolve().selection.attributes[0].options[0].width).toBe(10.1);
  });

  test('a profile edit changes its content version even if the revision was not bumped', () => {
    const accepted = resolve(), retained = copy(accepted);
    definition.manufacturing.trimMm.width = 102;
    expect(resolve().version).not.toBe(accepted.version);
    definition.revision++;
    expect(resolve().revision).toBe(2);
    expect(accepted).toEqual(retained);
  });

  test('returns detached values and does not mutate the catalogue or definition', () => {
    const before = JSON.stringify({ catalogue, definition });
    const snapshot = resolve();
    snapshot.selection.attributes[0].options[0].width = 999;
    snapshot.manufacturing.fitModes.push('unsupported');
    expect(JSON.stringify({ catalogue, definition })).toBe(before);
    expect(resolve().selection.attributes[0].options[0].width).toBe(10);
  });

  test.each([
    ['trimMm', 'width', 0], ['trimMm', 'height', Infinity], ['trimMm', 'width', '100'],
    ['bleedMm', 'top', -1], ['safeInsetMm', 'left', 102],
    ['resolution', 'targetDpi', 601], ['resolution', 'minimumDpi', 301],
    ['output', 'format', 'pdf'], ['output', 'colourSpace', 'cmyk'],
  ])('rejects unsupported/invalid %s.%s=%s', (group, key, value) => {
    definition.manufacturing[group][key] = value;
    expect(resolve).toThrow(ValidationError);
  });

  test.each(['book', 'folded-card', 'phone-case'])('rejects unsupported rendering capability %s', (value) => {
    definition.manufacturing.capability = value;
    expect(resolve).toThrow(ValidationError);
  });

  test.each([[[]], [['fill']], [['cover', 'cover']]])('rejects invalid fit modes %j', (value) => {
    definition.manufacturing.fitModes = value;
    expect(resolve).toThrow(ValidationError);
  });

  test.each(['wrapMm', 'iccProfile', 'mask'])('rejects unimplemented manufacturing requirement %s', (key) => {
    definition.manufacturing[key] = 'unsupported';
    expect(resolve).toThrow(ValidationError);
  });

  test('refuses oversized production output instead of silently reducing resolution', () => {
    definition.manufacturing.trimMm = { width: 2000, height: 2000 };
    expect(resolve).toThrow('60 megapixel');
  });

  test('rejects safe edges that meet or cross within the trim', () => {
    definition.manufacturing.safeInsetMm.left = 51;
    definition.manufacturing.safeInsetMm.right = 51;
    expect(resolve).toThrow('positive area');
  });

  test('does not interpret an ICC requirement as supported sRGB output', () => {
    definition.manufacturing.output.iccProfile = 'unimplemented-profile';
    expect(resolve).toThrow(ValidationError);
  });

  test('has a bounded profile list', () => {
    expect(() => resolveProfile(catalogue, Array(101).fill(definition), selection)).toThrow('at most 100');
  });

  test.each([0, -1, 1.5, '1'])('requires a positive integer profile revision: %s', (revision) => {
    definition.revision = revision;
    expect(resolve).toThrow(ValidationError);
  });

  test('does not accept commercial amounts or buyer-supplied manufacturing overrides', () => {
    definition.price = 10;
    expect(resolve).toThrow(ValidationError);
    delete definition.price;
    selection.manufacturing = definition.manufacturing;
    expect(resolve).toThrow(ValidationError);
  });

  test('cannot compile a legacy model/colour product as a rectangular profile', () => {
    catalogue.products[0] = { id: id(300), active: true, models: [], colours: [] };
    expect(() => defineProfile(catalogue, definition)).toThrow('shared-library product');
  });
});
