/**
 * The runner's ledger (`migrations.filename`) as a native database dump
 * carries it, read before the dump replaces this install's database
 * (issue 2480). The portable import reads data/migrations.ndjson; a native
 * backup holds the ledger inside the dump itself:
 *
 * - SQLite: the dump is a copy of the database file (`.backup`), optionally
 *   gzipped. It is opened read-only.
 * - PostgreSQL: a plain-format pg_dump (`--format=plain`), optionally
 *   gzipped. The ledger is the `COPY ... migrations` block pg_dump writes, or
 *   INSERT statements for a dump made with --inserts / --column-inserts.
 *
 * Every reader resolves to the list of filenames, null when the dump holds no
 * migrations table, or throws LedgerUnreadableError when the dump cannot be
 * read as one of these formats.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');
const { StringDecoder } = require('string_decoder');

class LedgerUnreadableError extends Error {}

const TABLE = String.raw`(?:(?:"public"|public)\.)?(?:"migrations"|migrations)`;
const COPY_LEDGER_RE = new RegExp(String.raw`^COPY\s+${TABLE}\s*\(([^)]*)\)\s+FROM\s+stdin;\s*$`, 'i');
const COPY_ANY_RE = /^COPY\s+\S.*\s+FROM\s+stdin;\s*$/i;
const CREATE_LEDGER_RE = new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}\s*\(\s*$`, 'i');
// The tuples may follow on the next lines (--rows-per-insert).
const INSERT_LEDGER_RE = new RegExp(String.raw`^INSERT\s+INTO\s+${TABLE}\s*(?:\(([^)]*)\))?\s*VALUES\b(.*)$`, 'i');

const identifiers = list => list.split(',').map(name => name.trim().replace(/^"(.*)"$/, '$1'));

// COPY's text format: \N is NULL, backslash escapes for control characters,
// octal and hex bytes.
const COPY_ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
function copyField(raw) {
  if (raw === '\\N') return null;
  return raw.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/g, (_, oct, hex, ch) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return COPY_ESCAPES[ch] ?? ch;
  });
}

// The value tuples of one INSERT: `(1, '001_init.js', '2025-…'), (…)`.
// Strings are standard-conforming (pg_dump sets standard_conforming_strings
// on); any other token is kept as written.
function insertTuples(text) {
  const tuples = [];
  let i = 0;
  const skipSpace = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  for (;;) {
    skipSpace();
    if (text[i] !== '(') throw new LedgerUnreadableError('INSERT values are not a tuple');
    i += 1;
    const values = [];
    for (;;) {
      skipSpace();
      let value;
      if (text[i] === '\'') {
        let out = '';
        i += 1;
        for (;;) {
          if (i >= text.length) throw new LedgerUnreadableError('Unterminated string in INSERT');
          if (text[i] === '\'') {
            if (text[i + 1] === '\'') { out += '\''; i += 2; continue; }
            i += 1;
            break;
          }
          out += text[i];
          i += 1;
        }
        value = out;
        // A cast such as '…'::timestamp belongs to the value.
        while (i < text.length && !/[,)]/.test(text[i])) i += 1;
      } else {
        const start = i;
        while (i < text.length && !/[,)]/.test(text[i])) i += 1;
        const token = text.slice(start, i).trim();
        value = /^null$/i.test(token) ? null : token;
      }
      values.push(value);
      skipSpace();
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === ')') { i += 1; break; }
      throw new LedgerUnreadableError('Malformed INSERT values');
    }
    tuples.push(values);
    skipSpace();
    if (i >= text.length) return tuples;
    if (text[i] !== ',') throw new LedgerUnreadableError('Malformed INSERT values');
    i += 1;
  }
}

/**
 * A line-by-line reader of a plain pg_dump. Feed it every line, then call
 * end() for the ledger.
 */
function pgDumpLedgerParser() {
  let names = null;
  let tableColumns = null;
  let inCreate = false;
  let createColumns = [];
  let copy = null; // { ledger: boolean, index }
  let insert = null; // { index, text } until the statement's closing ';'

  const filenameIndex = (columns) => {
    const index = columns.indexOf('filename');
    if (index < 0) throw new LedgerUnreadableError('The migrations table has no filename column');
    return index;
  };
  const add = (value) => {
    if (names === null) names = [];
    if (typeof value === 'string') names.push(value);
  };

  const insertLine = (text) => {
    insert.text += `\n${text}`;
    const statement = insert.text.trim();
    if (!statement.endsWith(';')) return;
    for (const tuple of insertTuples(statement.slice(0, -1))) add(tuple[insert.index]);
    insert = null;
  };

  return {
    line(line) {
      if (insert) { insertLine(line); return; }
      if (copy) {
        if (line === '\\.') { copy = null; return; }
        if (copy.ledger) add(copyField(line.split('\t')[copy.index] ?? '\\N'));
        return;
      }
      if (inCreate) {
        if (/^\s*\);?\s*$/.test(line) || /^\)/.test(line)) {
          inCreate = false;
          tableColumns = createColumns;
          if (names === null) names = [];
          return;
        }
        const m = line.match(/^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s/);
        if (m && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(m[1])) {
          createColumns.push(m[1].replace(/^"(.*)"$/, '$1'));
        }
        return;
      }
      const copyLedger = line.match(COPY_LEDGER_RE);
      if (copyLedger) {
        if (names === null) names = [];
        copy = { ledger: true, index: filenameIndex(identifiers(copyLedger[1])) };
        return;
      }
      if (COPY_ANY_RE.test(line)) { copy = { ledger: false }; return; }
      if (CREATE_LEDGER_RE.test(line)) { inCreate = true; createColumns = []; return; }
      const start = line.match(INSERT_LEDGER_RE);
      if (start) {
        const columns = start[1] ? identifiers(start[1]) : tableColumns;
        if (!columns) throw new LedgerUnreadableError('INSERT into migrations before its CREATE TABLE');
        insert = { index: filenameIndex(columns), text: '' };
        insertLine(start[2]);
      }
    },
    end() {
      if (copy && copy.ledger) throw new LedgerUnreadableError('The dump ends inside the migrations COPY block');
      if (inCreate) throw new LedgerUnreadableError('The dump ends inside the migrations CREATE TABLE');
      if (insert) throw new LedgerUnreadableError('The dump ends inside an INSERT into migrations');
      return names;
    },
  };
}

/** The ledger of a plain pg_dump read from a byte or text stream (and the
 * transforms it goes through, such as a gunzip). */
async function readPgDumpLedger(...streams) {
  const parser = pgDumpLedgerParser();
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let first = true;
  const feed = (text) => {
    rest += text;
    let newline;
    while ((newline = rest.indexOf('\n')) >= 0) {
      parser.line(rest.slice(0, newline).replace(/\r$/, ''));
      rest = rest.slice(newline + 1);
    }
  };
  await pipeline(...streams, new Writable({
    write(chunk, _enc, done) {
      try {
        // A custom-format archive (pg_dump -Fc) is not something psql
        // replays, nor something this reader can parse.
        if (first && Buffer.isBuffer(chunk) && chunk.subarray(0, 5).toString('latin1') === 'PGDMP') {
          throw new LedgerUnreadableError('The dump is a pg_dump custom-format archive, not a plain SQL dump');
        }
        first = false;
        feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
        done();
      } catch (err) { done(err); }
    },
    final(done) {
      try {
        feed(decoder.end());
        if (rest) parser.line(rest.replace(/\r$/, ''));
        done();
      } catch (err) { done(err); }
    },
  }));
  return parser.end();
}

/** The ledger of a SQLite database file, opened read-only. */
async function readSqliteLedger(file) {
  const sqlite3 = require('sqlite3');
  const handle = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => (err ? reject(err) : resolve(opened)));
  });
  const all = sql => new Promise((resolve, reject) => {
    // Array.from: rows built by the native binding live in another realm
    // under Jest.
    handle.all(sql, (err, rows) => (err ? reject(err) : resolve(Array.from(rows || []))));
  });
  try {
    const tables = await all('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'migrations\'');
    if (!tables.length) return null;
    const rows = await all('SELECT filename FROM migrations');
    return rows.map(row => row.filename).filter(name => typeof name === 'string');
  } catch (err) {
    throw new LedgerUnreadableError(`The dump is not a SQLite database this restore can read: ${err.message}`);
  } finally {
    await new Promise(resolve => handle.close(() => resolve()));
  }
}

/**
 * The ledger of the dump at dumpPath (a `.gz` name is gunzipped, as the
 * restore does). `engine` is 'sqlite' or 'postgresql'. A gzipped SQLite dump
 * is expanded into scratchDir first and removed again.
 */
async function readDumpLedger(dumpPath, engine, { scratchDir = path.dirname(dumpPath) } = {}) {
  const gz = dumpPath.endsWith('.gz');
  try {
    if (engine === 'postgresql') {
      const source = fs.createReadStream(dumpPath);
      return await (gz ? readPgDumpLedger(source, zlib.createGunzip()) : readPgDumpLedger(source));
    }
    if (!gz) return await readSqliteLedger(dumpPath);
    const expanded = path.join(scratchDir, `ledger-check-${process.pid}-${Date.now()}.db`);
    try {
      await pipeline(fs.createReadStream(dumpPath), zlib.createGunzip(), fs.createWriteStream(expanded, { mode: 0o600 }));
      return await readSqliteLedger(expanded);
    } finally {
      await fs.promises.rm(expanded, { force: true });
    }
  } catch (err) {
    if (err instanceof LedgerUnreadableError) throw err;
    throw new LedgerUnreadableError(`The database dump could not be read: ${err.message}`);
  }
}

module.exports = { readDumpLedger, readPgDumpLedger, readSqliteLedger, pgDumpLedgerParser, LedgerUnreadableError };
