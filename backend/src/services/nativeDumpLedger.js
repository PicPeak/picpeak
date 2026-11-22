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

// The most a ledger statement, a ledger COPY row or the head of any line is
// buffered to. A migrations row or INSERT header never comes close; past it
// the dump is unreadable (warn path) rather than held in memory.
const LINE_CAP = 1024 * 1024;
// How much of a line at a statement start is looked at to decide whether it
// can be a ledger statement (COPY / CREATE TABLE / INSERT INTO migrations).
const HEAD_BYTES = 256;

// Where the SQL read so far leaves the lexer: inside a string, quoted
// identifier, dollar-quoted body or comment, and whether the last token
// outside all of them ended a statement. Only a line that starts at a
// statement boundary can be a ledger statement; text inside another table's
// string value (a multi-line event title in an --inserts dump, a function
// body) never is. It reads any piece of the stream at a time, so a long
// value is scanned once, as it arrives, and never buffered.
function sqlLexer() {
  let mode = 'code'; // code | sq | sqEnd | esq | esqEsc | dq | dqEnd | dash | slash | line | block | blockStar | blockSlash | tag | dollar
  let depth = 0; // block comment nesting
  let ended = true;
  let prev1 = ''; // the two code characters before the current one
  let prev2 = '';
  let tag = '';
  let close = '';
  let matched = 0; // how much of `$tag$` the dollar body has matched
  const ident = ch => /[A-Za-z0-9_]/.test(ch);

  const code = (c) => {
    if (c === '-') { mode = 'dash'; return; }
    if (c === '/') { mode = 'slash'; return; }
    if (/\s/.test(c)) { prev2 = prev1; prev1 = c; return; }
    ended = c === ';';
    if (c === '\'') {
      mode = (prev1 === 'E' || prev1 === 'e') && !ident(prev2) ? 'esq' : 'sq';
    } else if (c === '"') {
      mode = 'dq';
    } else if (c === '$' && !ident(prev1)) {
      mode = 'tag';
      tag = '';
    }
    prev2 = prev1; prev1 = c;
  };

  const step = (c) => {
    switch (mode) {
    case 'code': code(c); return;
    case 'sq': if (c === '\'') mode = 'sqEnd'; return;
    case 'sqEnd': if (c === '\'') { mode = 'sq'; return; } mode = 'code'; prev1 = '\''; code(c); return;
    case 'esq': if (c === '\\') mode = 'esqEsc'; else if (c === '\'') mode = 'sqEnd'; return;
    case 'esqEsc': mode = 'esq'; return;
    case 'dq': if (c === '"') mode = 'dqEnd'; return;
    case 'dqEnd': if (c === '"') { mode = 'dq'; return; } mode = 'code'; prev1 = '"'; code(c); return;
    case 'dash':
      if (c === '-') { mode = 'line'; return; }
      mode = 'code'; ended = false; prev2 = prev1; prev1 = '-'; code(c); return;
    case 'slash':
      if (c === '*') { mode = 'block'; depth = 1; return; }
      mode = 'code'; ended = false; prev2 = prev1; prev1 = '/'; code(c); return;
    case 'line': if (c === '\n') mode = 'code'; return;
    case 'block': if (c === '*') mode = 'blockStar'; else if (c === '/') mode = 'blockSlash'; return;
    case 'blockStar':
      if (c === '/') { depth -= 1; mode = depth ? 'block' : 'code'; return; }
      mode = 'block'; step(c); return;
    case 'blockSlash':
      if (c === '*') { depth += 1; mode = 'block'; return; }
      mode = 'block'; step(c); return;
    case 'tag':
      if (c === '$') { close = `$${tag}$`; matched = 0; mode = 'dollar'; return; }
      if ((tag ? /[A-Za-z0-9_]/ : /[A-Za-z_]/).test(c) && tag.length < 64) { tag += c; return; }
      // `$1` or a lone `$`: not a dollar quote.
      mode = 'code'; prev1 = tag ? tag[tag.length - 1] : '$'; code(c); return;
    case 'dollar':
      if (c === close[matched]) {
        matched += 1;
        if (matched === close.length) { mode = 'code'; prev1 = '$'; }
      } else {
        matched = c === '$' ? 1 : 0;
      }
      return;
    default: throw new Error(`lexer mode ${mode}`);
    }
  };

  return {
    scan(text) { for (let i = 0; i < text.length; i += 1) step(text[i]); },
    neutral: () => mode === 'code' || mode === 'line' || mode === 'dash' || mode === 'slash',
    atStatementStart: () => (mode === 'code' || mode === 'line') && ended,
    ended: () => ended,
  };
}

/**
 * A streaming reader of a plain pg_dump: feed() it the text as it arrives,
 * then end() for the ledger. Ledger statements are recognised only where a
 * statement starts. Every byte is looked at once; nothing longer than
 * LINE_CAP is ever held (maxBuffered reports the most that was), and COPY
 * data of other tables is skipped without buffering its rows. A dump that
 * ends inside a string or statement, or a ledger line past the cap, is
 * unreadable rather than read as a guess.
 */
function pgDumpLedgerParser() {
  let names = null;
  let tableColumns = null;
  let create = null; // column names while inside CREATE TABLE migrations
  let insert = null; // { index, text } until the statement's closing ';'
  // What the current line is: 'start' (beginning of a line), 'head' (the
  // first bytes of a line at a statement start, held to classify it),
  // 'lex' (the rest of a line that is no ledger statement: lexed, not
  // held), 'meta' (a psql \command line), 'line' (a whole line held for
  // the ledger: a COPY header, CREATE/INSERT INTO migrations, a ledger row),
  // 'copySkip' (another table's COPY data).
  let mode = 'start';
  let buf = '';
  let copyLedger = null; // { index } inside the migrations COPY block
  // copySkip: the first bytes of the current data line, enough to see `\.`.
  let skipHead = '';
  let skipLen = 0;
  let maxBuffered = 0;
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
  const hold = (text) => {
    buf += text;
    if (buf.length > LINE_CAP) throw new LedgerUnreadableError(`A ledger line of the dump is longer than ${LINE_CAP} characters`);
    if (buf.length > maxBuffered) maxBuffered = buf.length;
  };
  const statementDone = () => lexer.neutral() && lexer.ended();

  const insertLine = (text) => {
    insert.text += `\n${text}`;
    if (insert.text.length > LINE_CAP) throw new LedgerUnreadableError('An INSERT into migrations is longer than the cap');
    if (insert.text.length > maxBuffered) maxBuffered = insert.text.length;
    lexer.scan(`${text}\n`);
    if (!statementDone()) return;
    const statement = insert.text.trim();
    if (!statement.endsWith(';')) throw new LedgerUnreadableError('Malformed INSERT into migrations');
    for (const tuple of insertTuples(statement.slice(0, -1))) add(tuple[insert.index]);
    insert = null;
  };

  // A whole held line, without its newline.
  const line = (text) => {
    if (copyLedger) {
      if (text === '\\.') { copyLedger = null; return; }
      add(copyField(text.split('\t')[copyLedger.index] ?? '\\N'));
      return;
    }
    if (insert) { insertLine(text); return; }
    if (create) {
      if (lexer.neutral()) {
        const m = text.match(/^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s/);
        if (m && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(m[1])) {
          create.push(m[1].replace(/^"(.*)"$/, '$1'));
        }
      }
      lexer.scan(`${text}\n`);
      if (statementDone()) {
        tableColumns = create;
        create = null;
        if (names === null) names = [];
      }
      return;
    }
    // A line at a statement start.
    const ledgerCopy = text.match(COPY_LEDGER_RE);
    if (ledgerCopy) {
      if (names === null) names = [];
      copyLedger = { index: filenameIndex(identifiers(ledgerCopy[1])) };
      return;
    }
    if (COPY_ANY_RE.test(text)) { mode = 'copySkip'; skipHead = ''; skipLen = 0; return; }
    if (CREATE_LEDGER_RE.test(text)) { create = []; lexer.scan(`${text}\n`); return; }
    const start = text.match(INSERT_LEDGER_RE);
    if (start) {
      const columns = start[1] ? identifiers(start[1]) : tableColumns;
      if (!columns) throw new LedgerUnreadableError('INSERT into migrations before its CREATE TABLE');
      insert = { index: filenameIndex(columns), text: '' };
      // The header itself holds no quote; the lexer sees only the values.
      lexer.scan(text.slice(0, text.length - start[2].length));
      insertLine(start[2]);
      return;
    }
    lexer.scan(`${text}\n`);
  };

  // Whether the head of a line at a statement start may be a ledger
  // statement (held whole) or is anything else (lexed as it streams).
  const ledgerHead = head => /^COPY\s/i.test(head)
    || new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}[\s(]`, 'i').test(head)
    || new RegExp(String.raw`^INSERT\s+INTO\s+${TABLE}[\s(]`, 'i').test(head);

  const endLine = (text) => {
    line(text.replace(/\r$/, ''));
    if (mode !== 'copySkip') mode = 'start';
  };

  const feed = (text) => {
    let pos = 0;
    while (pos < text.length) {
      if (mode === 'copySkip') {
        // Another table's COPY data: only `\.` alone on a line matters.
        const nl = text.indexOf('\n', pos);
        const stop = nl < 0 ? text.length : nl;
        if (skipHead.length < 3) skipHead += text.slice(pos, Math.min(stop, pos + 3 - skipHead.length));
        skipLen += stop - pos;
        if (nl < 0) return;
        if ((skipLen === 2 && skipHead === '\\.') || (skipLen === 3 && skipHead === '\\.\r')) mode = 'start';
        skipHead = '';
        skipLen = 0;
        pos = nl + 1;
        continue;
      }
      if (mode === 'start') {
        buf = '';
        if (copyLedger || insert || create) mode = 'line';
        else if (lexer.atStatementStart()) mode = 'head';
        else mode = 'lex';
      }
      const nl = text.indexOf('\n', pos);
      const stop = nl < 0 ? text.length : nl;
      if (mode === 'lex') {
        lexer.scan(text.slice(pos, nl < 0 ? text.length : nl + 1));
        if (nl >= 0) mode = 'start';
      } else if (mode === 'meta') {
        if (nl >= 0) mode = 'start';
      } else if (mode === 'line') {
        hold(text.slice(pos, stop));
        if (nl >= 0) endLine(buf);
      } else { // head
        const seg = text.slice(pos, Math.min(stop, pos + HEAD_BYTES - buf.length));
        hold(seg);
        pos += seg.length;
        if (nl >= 0 && pos === stop) {
          // The whole line is in: a psql \command, or a statement start.
          if (buf.startsWith('\\')) mode = 'start'; else endLine(buf);
          pos = nl + 1;
        } else if (buf.length >= HEAD_BYTES) {
          // A long line: decide on its head.
          if (buf.startsWith('\\')) { mode = 'meta'; buf = ''; } else if (ledgerHead(buf)) { mode = 'line'; } else {
            lexer.scan(buf);
            buf = '';
            mode = 'lex';
          }
        }
        continue;
      }
      pos = nl < 0 ? text.length : nl + 1;
    }
  };

  return {
    feed,
    /** A whole line, as feed() would take it with its newline. */
    line: text => feed(`${text}\n`),
    get maxBuffered() { return maxBuffered; },
    end() {
      // A last line without a newline.
      if (buf && (mode === 'head' || mode === 'line') && !(mode === 'head' && buf.startsWith('\\'))) endLine(buf);
      buf = '';
      if (copyLedger) throw new LedgerUnreadableError('The dump ends inside the migrations COPY block');
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
  let first = true;
  await pipeline(...streams, new Writable({
    write(chunk, _enc, done) {
      try {
        // A custom-format archive (pg_dump -Fc) is not something psql
        // replays, nor something this reader can parse.
        if (first && Buffer.isBuffer(chunk) && chunk.subarray(0, 5).toString('latin1') === 'PGDMP') {
          throw new LedgerUnreadableError('The dump is a pg_dump custom-format archive, not a plain SQL dump');
        }
        first = false;
        parser.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
        done();
      } catch (err) { done(err); }
    },
    final(done) {
      try {
        parser.feed(decoder.end());
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
