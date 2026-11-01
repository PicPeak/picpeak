const { toDateOnly } = require('../../src/utils/dateOnly');

describe('toDateOnly', () => {
  test('a pg Date at local midnight keeps its calendar day, east or west of UTC', () => {
    // The pg driver builds `new Date(y, m, d)` in the server's zone; the
    // local components are the day the row holds, whatever toISOString says.
    const local = new Date(2026, 9, 3);
    expect(toDateOnly(local)).toBe('2026-10-03');
    // One minute into the day still reads as that day, not as UTC's.
    expect(toDateOnly(new Date(2026, 0, 1, 0, 1))).toBe('2026-01-01');
  });

  test('SQLite text passes through, with any time component dropped', () => {
    expect(toDateOnly('2026-10-03')).toBe('2026-10-03');
    expect(toDateOnly('2026-10-03T00:00:00.000Z')).toBe('2026-10-03');
    expect(toDateOnly('2026-10-03 00:00:00')).toBe('2026-10-03');
  });

  test('no date stays no date', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly(undefined)).toBeNull();
    expect(toDateOnly('')).toBeNull();
    expect(toDateOnly(new Date('nope'))).toBeNull();
  });
});

describe('every gallery payload that carries event_date goes through toDateOnly', () => {
  // GalleryAuthContext caches the event from whichever of these answered
  // last; one raw pg Date among them brings the previous-day shift back.
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');

  test.each([
    ['routes/auth.js', 3],
    ['routes/gallery/metadata.js', 1],
    ['services/galleryQueryService.js', 1],
  ])('%s', (rel, count) => {
    const src = read(rel);
    expect(src.match(/toDateOnly\(event\.event_date\)/g) || []).toHaveLength(count);
    expect(src).not.toMatch(/event_date: event\.event_date,/);
  });
});

describe('every quote, invoice and contract payload sends its date columns through toDateOnly', () => {
  // Issue 2333: on PostgreSQL a raw `date` column reaches the browser as
  // "2026-03-01T00:00:00.000Z", a day early anywhere west of UTC, and a
  // date input refuses it. The PDF render contexts format server-side and
  // keep the driver's Date on purpose; these are the JSON payloads.
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
  const COLUMNS = 'issue_date|valid_until|due_date|event_date|monthly_period_start|monthly_period_end';
  const RAW = new RegExp(`\\b\\w+: \\w+\\.(?:${COLUMNS})(?: \\|\\| null)?,`, 'g');
  const WRAPPED = new RegExp(`toDateOnly\\(\\w+\\.(?:${COLUMNS})\\)`, 'g');

  test.each([
    ['routes/adminQuotes.js', 3],
    ['routes/adminInvoices.js', 5],
    ['routes/customer.js', 8],
    ['services/dealsService.js', 9],
    ['services/publicDocumentViews.js', 5],
    ['services/invoice/payments.js', 2],
    ['services/invoice/drafts.js', 2],
    ['services/contract/sendPreview.js', 2],
  ])('%s', (rel, count) => {
    const src = read(rel);
    expect(src.match(WRAPPED) || []).toHaveLength(count);
    expect(src.match(RAW) || []).toEqual([]);
  });
});
