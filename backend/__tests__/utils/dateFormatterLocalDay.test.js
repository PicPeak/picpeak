const path = require('path');
const { execFileSync } = require('child_process');

// Postgres hands a DATE column back as a Date at the server's local midnight.
// The YYYY-MM-DD format read it through toISOString(), so east of UTC the
// mail printed the day before; the other formats read the local day. The
// suite runs in the host's zone (UTC on CI) and TZ does not re-bind in a
// running process, so Europe/Berlin is forced in a child.
describe('formatDate with a Postgres DATE east of UTC', () => {
  it('prints the calendar day in every format', () => {
    const src = path.resolve(__dirname, '../../src');
    const out = execFileSync(process.execPath, ['-e', `
      const dbPath = require.resolve(${JSON.stringify(path.join(src, 'database/db'))});
      let format = 'YYYY-MM-DD';
      const db = () => ({ where: () => ({ first: async () => ({ setting_value: JSON.stringify({ format, locale: 'en-GB' }) }) }) });
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db } };
      const { formatDate } = require(${JSON.stringify(path.join(src, 'utils/dateFormatter'))});
      (async () => {
        const pgDate = new Date(2026, 9, 20); // what pg returns for DATE '2026-10-20'
        const seen = { offset: pgDate.getTimezoneOffset() };
        for (const f of ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY']) {
          format = f;
          seen[f] = await formatDate(pgDate, 'en');
        }
        format = 'YYYY-MM-DD';
        seen.bare = await formatDate('2026-10-20', 'en');
        process.stdout.write(JSON.stringify(seen));
      })();
    `], { env: { ...process.env, TZ: 'Europe/Berlin' }, encoding: 'utf8' });
    const seen = JSON.parse(out);
    expect(seen.offset).toBe(-120); // the zone really applies in the child
    expect(seen['YYYY-MM-DD']).toBe('2026-10-20');
    expect(seen['DD/MM/YYYY']).toBe('20/10/2026');
    expect(seen['MM/DD/YYYY']).toBe('10/20/2026');
    expect(seen['DD.MM.YYYY']).toBe('20.10.2026');
    expect(seen.bare).toBe('2026-10-20');
  });
});

// The gallery OG preview turned SQLite's bare event_date into a Date first,
// midnight UTC, which every local format names as the day before west of UTC.
describe('the OG preview date west of UTC', () => {
  it('prints the stored calendar day for SQLite text and a pg Date', () => {
    const src = path.resolve(__dirname, '../../src');
    const out = execFileSync(process.execPath, ['-e', `
      const dbPath = require.resolve(${JSON.stringify(path.join(src, 'database/db'))});
      let format = 'YYYY-MM-DD';
      const db = () => ({ where: () => ({ first: async () => ({ setting_value: JSON.stringify({ format, locale: 'en-GB' }) }) }) });
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db } };
      const { formatEventDate } = require(${JSON.stringify(path.join(src, 'services/galleryOgService'))});
      (async () => {
        const seen = { offset: new Date(2026, 9, 20).getTimezoneOffset() };
        for (const f of ['YYYY-MM-DD', 'DD/MM/YYYY']) {
          format = f;
          seen[f] = [await formatEventDate('2026-10-20'), await formatEventDate(new Date(2026, 9, 20))];
        }
        seen.invalid = await formatEventDate('not a date');
        process.stdout.write(JSON.stringify(seen));
        process.exit(0);
      })();
    `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
    const seen = JSON.parse(out);
    expect(seen.offset).toBe(240);
    expect(seen['YYYY-MM-DD']).toEqual(['2026-10-20', '2026-10-20']);
    expect(seen['DD/MM/YYYY']).toEqual(['20/10/2026', '20/10/2026']);
    expect(seen.invalid).toBeNull();
  });
});
