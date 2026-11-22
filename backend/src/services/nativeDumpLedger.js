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
const { decompressLimiter, DecompressLimitError } = require('../utils/decompressLimit');

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
      const escaped = (text[i] === 'E' || text[i] === 'e') && text[i + 1] === '\'';
      if (escaped) i += 1;
      if (text[i] === '\'') {
        let out = '';
        i += 1;
        for (;;) {
          if (i >= text.length) throw new LedgerUnreadableError('Unterminated string in INSERT');
          if (escaped && text[i] === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
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

// Where a line of SQL leaves the lexer: inside a string, quoted identifier,
// dollar-quoted body or block comment, and whether the last token outside
// all of them ended a statement. Only a line that starts at a statement
// boundary can be a ledger statement; text inside another table's string
// value (a multi-line event title in an --inserts dump, a function body)
// never is.
function sqlLexer() {
  const state = { quote: null, dollar: null, comment: 0, ended: true };
  const identChar = ch => /[A-Za-z0-9_]/.test(ch || '');
  return {
    atStatementStart: () => state.quote === null && state.dollar === null && state.comment === 0 && state.ended,
    neutral: () => state.quote === null && state.dollar === null && state.comment === 0,
    ended: () => state.ended,
    scan(line) {
      let i = 0;
      while (i < line.length) {
        const c = line[i];
        if (state.comment > 0) {
          if (c === '*' && line[i + 1] === '/') { state.comment -= 1; i += 2; continue; }
          if (c === '/' && line[i + 1] === '*') { state.comment += 1; i += 2; continue; }
          i += 1; continue;
        }
        if (state.dollar !== null) {
          const close = `$${state.dollar}$`;
          if (line.startsWith(close, i)) { state.dollar = null; i += close.length; continue; }
          i += 1; continue;
        }
        if (state.quote === '\'' || state.quote === 'E\'') {
          if (state.quote === 'E\'' && c === '\\') { i += 2; continue; }
          if (c === '\'') {
            if (line[i + 1] === '\'') { i += 2; continue; }
            state.quote = null;
          }
          i += 1; continue;
        }
        if (state.quote === '"') {
          if (c === '"') {
            if (line[i + 1] === '"') { i += 2; continue; }
            state.quote = null;
          }
          i += 1; continue;
        }
        if (c === '-' && line[i + 1] === '-') break;
        if (c === '/' && line[i + 1] === '*') { state.comment = 1; i += 2; continue; }
        if (/\s/.test(c)) { i += 1; continue; }
        state.ended = c === ';';
        if (c === '\'') {
          state.quote = (line[i - 1] === 'E' || line[i - 1] === 'e') && !identChar(line[i - 2]) ? 'E\'' : '\'';
        } else if (c === '"') {
          state.quote = '"';
        } else if (c === '$' && !identChar(line[i - 1])) {
          const tag = line.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
          if (tag) { state.dollar = tag[1] || ''; i += tag[0].length; continue; }
        }
        i += 1;
      }
    },
  };
}

/**
 * A line-by-line reader of a plain pg_dump. Feed it every line, then call
 * end() for the ledger. Ledger statements are recognised only where a
 * statement starts; a dump that ends inside a string or statement is
 * unreadable rather than read as a guess.
 */
function pgDumpLedgerParser() {
  let names = null;
  let tableColumns = null;
  let create = null; // column names while inside CREATE TABLE migrations
  let copy = null; // { ledger: boolean, index }
  let insert = null; // { index, text } until the statement's closing ';'
  const lexer = sqlLexer();

  const filenameIndex = (columns) => {
    const index = columns.indexOf('filename');
    if (index < 0) throw new LedgerUnreadableError('The migrations table has no filename column');
    return index;
  };
  const add = (value) => {
    if (names === null) names = [];
    if (typeof value === 'string') names.push(value);
  };
  const statementDone = () => lexer.neutral() && lexer.ended();

  const insertLine = (text) => {
    insert.text += `\n${text}`;
    lexer.scan(text);
    if (!statementDone()) return;
    const statement = insert.text.trim();
    if (!statement.endsWith(';')) throw new LedgerUnreadableError('Malformed INSERT into migrations');
    for (const tuple of insertTuples(statement.slice(0, -1))) add(tuple[insert.index]);
    insert = null;
  };

  return {
    line(line) {
      if (copy) {
        // COPY data: one row per line, newlines inside values escaped.
        if (line === '\\.') { copy = null; return; }
        if (copy.ledger) add(copyField(line.split('\t')[copy.index] ?? '\\N'));
        return;
      }
      if (insert) { insertLine(line); return; }
      if (create) {
        if (lexer.neutral()) {
          const m = line.match(/^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s/);
          if (m && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(m[1])) {
            create.push(m[1].replace(/^"(.*)"$/, '$1'));
          }
        }
        lexer.scan(line);
        if (statementDone()) {
          tableColumns = create;
          create = null;
          if (names === null) names = [];
        }
        return;
      }
      if (lexer.atStatementStart()) {
        // psql meta-commands (\connect, \restrict) end at the line.
        if (/^\\/.test(line)) return;
        const copyLedger = line.match(COPY_LEDGER_RE);
        if (copyLedger) {
          if (names === null) names = [];
          copy = { ledger: true, index: filenameIndex(identifiers(copyLedger[1])) };
          return;
        }
        if (COPY_ANY_RE.test(line)) { copy = { ledger: false }; return; }
        if (CREATE_LEDGER_RE.test(line)) { create = []; lexer.scan(line); return; }
        const start = line.match(INSERT_LEDGER_RE);
        if (start) {
          const columns = start[1] ? identifiers(start[1]) : tableColumns;
          if (!columns) throw new LedgerUnreadableError('INSERT into migrations before its CREATE TABLE');
          insert = { index: filenameIndex(columns), text: '' };
          // The header itself holds no quote; the lexer sees only the values.
          lexer.scan(line.slice(0, line.length - start[2].length));
          insertLine(start[2]);
          return;
        }
      }
      lexer.scan(line);
    },
    end() {
      if (copy && copy.ledger) throw new LedgerUnreadableError('The dump ends inside the migrations COPY block');
      if (create) throw new LedgerUnreadableError('The dump ends inside the migrations CREATE TABLE');
      if (insert) throw new LedgerUnreadableError('The dump ends inside an INSERT into migrations');
      if (!lexer.neutral()) throw new LedgerUnreadableError('The dump ends inside a quoted string or comment');
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
 * restore does, under the same RESTORE_MAX_DECOMPRESSED_BYTES cap:
 * DecompressLimitError past it). `engine` is 'sqlite' or 'postgresql'. A
 * gzipped SQLite dump is expanded into scratchDir first and removed again.
 */
async function readDumpLedger(dumpPath, engine, { scratchDir = path.dirname(dumpPath) } = {}) {
  const gz = dumpPath.endsWith('.gz');
  try {
    if (engine === 'postgresql') {
      const source = fs.createReadStream(dumpPath);
      return await (gz ? readPgDumpLedger(source, zlib.createGunzip(), decompressLimiter()) : readPgDumpLedger(source));
    }
    if (!gz) return await readSqliteLedger(dumpPath);
    const expanded = path.join(scratchDir, `ledger-check-${process.pid}-${Date.now()}.db`);
    try {
      await pipeline(fs.createReadStream(dumpPath), zlib.createGunzip(), decompressLimiter(),
        fs.createWriteStream(expanded, { mode: 0o600 }));
      return await readSqliteLedger(expanded);
    } finally {
      await fs.promises.rm(expanded, { force: true });
    }
  } catch (err) {
    // An oversize dump is the restore's own refusal (decompressFile), not a
    // ledger this check failed to read.
    if (err instanceof LedgerUnreadableError || err instanceof DecompressLimitError) throw err;
    throw new LedgerUnreadableError(`The database dump could not be read: ${err.message}`);
  }
}

module.exports = { readDumpLedger, readPgDumpLedger, readSqliteLedger, pgDumpLedgerParser, LedgerUnreadableError };
