const path = require('path');
const { execFileSync } = require('child_process');

// SQLite's CURRENT_TIMESTAMP default is 'YYYY-MM-DD HH:MM:SS' in UTC with no
// zone. julianday() and the frontend read it as UTC; toTimestamp read it in
// the server's zone, hours off on a non-UTC server. The suite runs in the
// host's zone (UTC on CI), where both readings agree, and TZ does not re-bind
// in a running process, so the zone the bug needs is forced in a child.
describe('toTimestamp', () => {
  it('reads a zone-less date-time as UTC whatever the server zone', () => {
    const helper = path.resolve(__dirname, '../../src/utils/dateNormalize');
    const out = execFileSync(process.execPath, ['-e', `
      const { toTimestamp } = require(${JSON.stringify(helper)});
      process.stdout.write(JSON.stringify({
        offset: new Date('2026-12-24T12:00:00Z').getTimezoneOffset(),
        space: toTimestamp('2026-12-24 22:59:59'),
        t: toTimestamp('2026-12-24T22:59'),
        fraction: toTimestamp('2026-12-24 22:59:59.500'),
        zoned: toTimestamp('2026-12-24T22:59:59+01:00'),
        bare: toTimestamp('2026-12-24'),
      }));
    `], { env: { ...process.env, TZ: 'Europe/Berlin' }, encoding: 'utf8' });
    const seen = JSON.parse(out);
    expect(seen.offset).toBe(-60); // the zone really applies in the child
    expect(seen.space).toBe(Date.parse('2026-12-24T22:59:59Z'));
    expect(seen.t).toBe(Date.parse('2026-12-24T22:59:00Z'));
    expect(seen.fraction).toBe(Date.parse('2026-12-24T22:59:59.500Z'));
    expect(seen.zoned).toBe(Date.parse('2026-12-24T21:59:59Z'));
    expect(seen.bare).toBe(Date.parse('2026-12-24T00:00:00Z'));
  });

  it('keeps the other shapes and fails closed on garbage', () => {
    const { toTimestamp } = require('../../src/utils/dateNormalize');
    expect(toTimestamp(1790000000000)).toBe(1790000000000);
    expect(toTimestamp('1790000000000')).toBe(1790000000000);
    expect(toTimestamp(new Date('2026-12-24T22:59:59Z'))).toBe(Date.parse('2026-12-24T22:59:59Z'));
    expect(toTimestamp('2026-12-24T22:59:59.000Z')).toBe(Date.parse('2026-12-24T22:59:59Z'));
    expect(toTimestamp('[object Object]')).toBeNaN();
    expect(toTimestamp(null)).toBeNaN();
  });
});
