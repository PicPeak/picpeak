/**
 * The fixed short date the quote, invoice and contract emails print
 * ({{due_date}}, {{valid_until}}, {{event_date}} …). A US business's customers
 * read month first, so 11/27/2026 can't be taken for 11 March; everyone else
 * keeps 27.11.2026.
 */

const { formatShortDate } = require('../../src/utils/dateFormatter');

// A local-midnight Date, as Postgres returns a DATE column, so the calendar
// day is the same in every time zone the suite runs in.
const dueDate = new Date(2026, 10, 27);

test('a US business prints month, day and year', () => {
  expect(formatShortDate(dueDate, 'US')).toBe('11/27/2026');
  expect(formatShortDate(dueDate, 'us')).toBe('11/27/2026');
});

test('a business elsewhere keeps day.month.year', () => {
  expect(formatShortDate(dueDate, 'LI')).toBe('27.11.2026');
  expect(formatShortDate(dueDate)).toBe('27.11.2026');
});

test('no date is still an empty string for a US business', () => {
  expect(formatShortDate(null, 'US')).toBe('');
});
