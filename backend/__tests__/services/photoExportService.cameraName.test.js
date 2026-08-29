/**
 * Photo exports name the camera master, not the delivered render (#1229).
 *
 * #1165 added `photos.source_filename` to this service's select and nothing
 * read it — every output still used `original_filename`, which is overwritten
 * the first time an edited render is uploaded over a proof (#745).
 *
 * So after a round-trip the exports named the render. Every format here exists
 * to help a photographer find the master on disk, and the render's name does
 * not. The XMP case is the sharpest: the sidecar is written next to a RAW
 * master, so a wrongly-named one is never associated with it.
 */

jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => ({
    where: () => ({ select: () => ({ first: async () => ({
      event_name: 'Smith Wedding', event_date: '2026-08-29', slug: 'smith-wedding',
    }) }) }),
  })),
}));

const mockXmpBaseNames = [];
jest.mock('../../src/services/xmpGenerator', () => ({
  XmpGenerator: class {
    getXmpFilename(base) {
      mockXmpBaseNames.push(base);
      return `${base.replace(/\.[^.]+$/, '')}.xmp`;
    }
    generateXmp() { return '<x:xmpmeta/>'; }
  },
}));

const { PhotoExportService } = require('../../src/services/photoExportService');
const service = new PhotoExportService();

// The post-round-trip row: the render's name landed in original_filename, the
// camera's name is still in source_filename.
const REPLACED = {
  id: 1,
  filename: 'wedding-smith_individual_1755892345.jpg',
  original_filename: 'Smith_Wedding_1234.jpg',
  source_filename: 'IMG_1234.JPG',
};

// Never replaced: source_filename holds what the camera wrote, same as original.
const UNTOUCHED = {
  id: 2,
  filename: 'wedding-smith_individual_1755892999.jpg',
  original_filename: 'IMG_5678.JPG',
  source_filename: 'IMG_5678.JPG',
};

// Predates migration 193 and its backfill — only the legacy column.
const LEGACY = {
  id: 3,
  filename: 'wedding-smith_individual_1755893111.jpg',
  original_filename: 'DSC_9001.NEF',
  source_filename: null,
};

// Nothing was ever recorded.
const BARE = {
  id: 4,
  filename: 'wedding-smith_individual_1755893222.jpg',
  original_filename: null,
  source_filename: null,
};

beforeEach(() => {
  mockXmpBaseNames.length = 0;
});

describe('exportAsTxt (#1229)', () => {
  it('lists the camera master after a replace, not the render', () => {
    const result = service.exportAsTxt([REPLACED], { include_extension: true });
    expect(result.content).toBe('IMG_1234.JPG');
  });

  it('still falls back to original_filename on rows with no source_filename', () => {
    const result = service.exportAsTxt([LEGACY, UNTOUCHED]);
    expect(result.content).toBe('DSC_9001.NEF\nIMG_5678.JPG');
  });

  it('falls back to the stored name when nothing was recorded', () => {
    // A usable name beats an empty line in a list meant for a catalog search.
    const result = service.exportAsTxt([BARE]);
    expect(result.content).toBe('wedding-smith_individual_1755893222.jpg');
  });

  it('filename_format=stored is unaffected', () => {
    const result = service.exportAsTxt([REPLACED], { filename_format: 'stored' });
    expect(result.content).toBe('wedding-smith_individual_1755892345.jpg');
  });
});

// Every cell is unconditionally quoted (formula-neutralized then wrapped),
// so strip the wrapper before comparing. No value under test contains a comma.
const cellsOf = (csv) => csv.split('\n')[1].split(',').map((c) => c.replace(/^"|"$/g, ''));

describe('exportAsCsv (#1229)', () => {
  it('names the master in both the filename cell and the original_filename column', () => {
    const cells = cellsOf(service.exportAsCsv([REPLACED]).content);
    expect(cells[0]).toBe('IMG_1234.JPG');
    expect(cells[1]).toBe('IMG_1234.JPG');
  });

  it('leaves the original_filename column blank when nothing was recorded', () => {
    const cells = cellsOf(service.exportAsCsv([BARE]).content);
    // Cell 0 still needs a usable name; the metadata column reports "unknown".
    expect(cells[0]).toBe('wedding-smith_individual_1755893222.jpg');
    expect(cells[1]).toBe('');
  });
});

describe('exportAsXmpZip (#1229)', () => {
  it('names the sidecar after the master so Lightroom associates it with the RAW', () => {
    service.exportAsXmpZip([REPLACED, LEGACY], {});
    expect(mockXmpBaseNames).toEqual(['IMG_1234.JPG', 'DSC_9001.NEF']);
  });

  it('filename_format=stored still uses the stored name', () => {
    service.exportAsXmpZip([REPLACED], { filename_format: 'stored' });
    expect(mockXmpBaseNames).toEqual(['wedding-smith_individual_1755892345.jpg']);
  });
});

describe('exportAsJson (#1229)', () => {
  it('reports the master as original_filename, and null when unrecorded', async () => {
    const result = await service.exportAsJson([REPLACED, BARE], 7, {});
    const parsed = JSON.parse(result.content);
    expect(parsed.photos[0].original_filename).toBe('IMG_1234.JPG');
    // The stored name stays its own field — this adds meaning, it does not swap.
    expect(parsed.photos[0].filename).toBe('wedding-smith_individual_1755892345.jpg');
    expect(parsed.photos[1].original_filename).toBeNull();
  });
});
