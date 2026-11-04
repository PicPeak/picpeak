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

// Run in a child process: the zone is read when Node starts.
test.each(['America/Denver', 'Pacific/Auckland'])('a bare day stays that day in %s', (TZ) => {
  const script = `
    const { formatShortDate } = require('./src/utils/dateFormatter');
    const { parseCalendarDate } = require('./src/utils/dateNormalize');
    const pdf = require('./src/services/pdfService')._internal;
    process.stdout.write(JSON.stringify([
      formatShortDate('2026-11-27', 'US'),
      formatShortDate('2026-11-27'),
      pdf.formatDate('2026-11-27', { format: 'MM/DD/YYYY' }),
      parseCalendarDate('2026-11-27').getDate(),
    ]));
    process.exit(0);
  `;
  const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..', '..'),
    env: { ...process.env, TZ, NODE_ENV: 'test', LOG_LEVEL: 'error' },
  });
  expect(JSON.parse(String(out).slice(String(out).lastIndexOf('[')))).toEqual(['11/27/2026', '27.11.2026', '11/27/2026', 27]);
}, 60000);

test('no date is still an empty string for a US business', () => {
  expect(formatShortDate(null, 'US')).toBe('');
});
