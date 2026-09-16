/**
 * Accounting change history is only complete if nothing writes an audited
 * table around it (migration 219, services/accountingHistory.js).
 *
 * Source inspection: every knex chain on an audited table in backend/src must
 * be a read. Inserts, updates and deletes go through auditedInsert /
 * auditedUpdate / auditedDelete, and the history table itself is only ever
 * inserted into, by the recorder.
 */
const fs = require('fs');
const path = require('path');
const { AUDITED_TABLES } = require('../../src/services/accountingHistory');
const DELETE_REFERENCES = require('../../src/services/accountingHistoryReferences');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const RECORDER = path.join(SRC, 'services', 'accountingHistory.js');
const WRITE = /\.(insert|update|del|delete|increment|decrement|upsert|merge|truncate)\s*\(/;
const RAW_WRITE = (table) => new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+["\`]?${table}\\b`, 'i');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// The statement a table reference starts, up to its terminating semicolon.
function statementsOn(text, table) {
  const found = [];
  const reference = new RegExp(`\\(\\s*['"\`]${table}['"\`]\\s*\\)`, 'g');
  let match;
  while ((match = reference.exec(text))) {
    const end = text.indexOf(';', match.index);
    const statement = text.slice(match.index, end === -1 ? undefined : end);
    const line = text.slice(0, match.index).split('\n').length;
    found.push({ statement, line });
  }
  return found;
}

function offenders(tables, allowFile, writePattern = WRITE) {
  const result = [];
  for (const file of sourceFiles(SRC)) {
    if (allowFile(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const table of tables) {
      for (const { statement, line } of statementsOn(text, table)) {
        if (writePattern.test(statement)) result.push(`${path.relative(SRC, file)}:${line} ${table}`);
      }
      text.split('\n').forEach((content, index) => {
        if (RAW_WRITE(table).test(content)) result.push(`${path.relative(SRC, file)}:${index + 1} ${table} (raw SQL)`);
      });
    }
  }
  return result;
}

describe('accounting change history coverage', () => {
  it('writes audited tables only through the recorder', () => {
    expect(offenders(Object.keys(AUDITED_TABLES), (file) => file === RECORDER)).toEqual([]);
  });

  it('routes parent deletions that can change audited records through the recorder', () => {
    const parents = Object.entries(DELETE_REFERENCES)
      .filter(([, refs]) => refs.some((ref) => AUDITED_TABLES[ref.table]))
      .map(([table]) => table);
    expect(offenders(parents, (file) => file === RECORDER, /\.(del|delete|truncate)\s*\(/)).toEqual([]);
  });

  it('never updates or deletes history rows, and only the recorder inserts them', () => {
    expect(offenders(['accounting_change_history'], () => false).filter((hit) => {
      const [location] = hit.split(' ');
      return !location.startsWith(`${path.relative(SRC, RECORDER)}:`);
    })).toEqual([]);
    // The one sanctioned rewrite: erasing a customer blanks the personal
    // values in that customer's own history (redactCustomerHistory).
    const recorder = fs.readFileSync(RECORDER, 'utf8');
    const redactStart = recorder.indexOf('async function redactCustomerHistory');
    const redactEnd = recorder.indexOf('\n}\n', redactStart);
    expect(redactStart).toBeGreaterThan(-1);
    const rewrites = [];
    const reference = /\(\s*['"`]accounting_change_history['"`]\s*\)/g;
    let match;
    while ((match = reference.exec(recorder))) {
      const end = recorder.indexOf(';', match.index);
      const statement = recorder.slice(match.index, end);
      expect(statement).not.toMatch(/\.(del|delete|increment|decrement|truncate)\s*\(/);
      if (/\.update\s*\(/.test(statement)) rewrites.push(match.index);
    }
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0] > redactStart && rewrites[0] < redactEnd).toBe(true);
  });
});
