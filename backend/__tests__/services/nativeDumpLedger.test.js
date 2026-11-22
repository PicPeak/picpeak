/**
 * The migration ledger inside a native database dump (issue 2480): the
 * restore reads it before the dump replaces anything.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const knex = require('knex');
const { Readable } = require('stream');
const {
  readDumpLedger, readPgDumpLedger, pgDumpLedgerParser, LedgerUnreadableError,
} = require('../../src/services/nativeDumpLedger');
const { DecompressLimitError } = require('../../src/utils/decompressLimit');

const fromText = text => Readable.from([Buffer.from(text, 'utf8')]);

// The shape pg_dump --format=plain writes (abridged).
const PLAIN_DUMP = [
  'SET statement_timeout = 0;',
  'SET standard_conforming_strings = on;',
  'CREATE TABLE public.events (',
  '    id integer NOT NULL,',
  '    title text',
  ');',
  'CREATE TABLE public.migrations (',
  '    id integer NOT NULL,',
  '    filename character varying(255) NOT NULL,',
  '    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP',
  ');',
  'COPY public.events (id, title) FROM stdin;',
  // A row of another table that only looks like a ledger statement.
  'COPY public.migrations (id, filename, executed_at) FROM stdin;',
  '\\.',
  'COPY public.migrations (id, filename, executed_at) FROM stdin;',
  '1\t001_init.js\t2025-01-01 00:00:00+00',
  '2\t366_fix_translated_email_template_placeholders.js\t2026-11-19 10:00:00+00',
  '3\t250_odd\\tname.js\t\\N',
  '\\.',
  '',
].join('\n');

describe('readPgDumpLedger', () => {
  it('reads the filenames of the migrations COPY block and skips other tables\' data', async () => {
    expect(await readPgDumpLedger(fromText(PLAIN_DUMP))).toEqual([
      '001_init.js', '366_fix_translated_email_template_placeholders.js', '250_odd\tname.js',
    ]);
  });

  it('reads a real pg_dump 16 plain dump, made with the options databaseBackup.js passes', async () => {
    // pg_dump --no-owner --no-privileges --clean --if-exists --format=plain
    // of a migrations table, plus an events row whose text looks like a
    // ledger COPY line.
    const fixture = path.join(__dirname, '../fixtures/pgDumpPlainLedger.sql');
    expect(await readPgDumpLedger(fs.createReadStream(fixture)))
      .toEqual(['001_init.js', '366_fix_translated_email_template_placeholders.js']);
  });

  it.each([
    ['plain (COPY)', 'pgDumpPlainAdversarial.sql'],
    ['--inserts', 'pgDumpInsertsAdversarial.sql'],
  ])('ignores ledger statements inside other tables\' strings and function bodies in a real %s dump', async (_format, name) => {
    // pg_dump 16 output of an events table whose titles hold multi-line
    // text "INSERT INTO public.migrations VALUES (9, '999_fake_insert.js');"
    // and a COPY block, plus a function whose dollar-quoted body holds a
    // "COPY public.migrations ... FROM stdin;" line.
    const fixture = path.join(__dirname, '../fixtures', name);
    expect(await readPgDumpLedger(fs.createReadStream(fixture)))
      .toEqual(['001_init.js', '366_fix_translated_email_template_placeholders.js']);
  });

  it('reads nothing as a ledger from inside a string, an E string or a comment', async () => {
    const dump = [
      'INSERT INTO public.events (id, title) VALUES (1, \'x',
      'INSERT INTO public.migrations VALUES (9, \'\'999_fake.js\'\');',
      'COPY public.migrations (id, filename) FROM stdin;',
      '\');',
      'INSERT INTO public.events (id, title) VALUES (2, E\'a\\\' still inside',
      'INSERT INTO public.migrations (id, filename) VALUES (9, \'\'999_fake.js\'\');',
      '\');',
      '/* INSERT INTO public.migrations (id, filename) VALUES (9, \'999_fake.js\'); */',
      'INSERT INTO public.migrations (id, filename) VALUES (1, E\'001_init.js\');',
      '',
    ].join('\n');
    expect(await readPgDumpLedger(fromText(dump))).toEqual(['001_init.js']);
  });

  it('is unreadable, not guessed, when the dump ends inside a string', async () => {
    const dump = 'INSERT INTO public.events (id, title) VALUES (1, \'never closed\nCOPY public.migrations (id, filename) FROM stdin;\n';
    await expect(readPgDumpLedger(fromText(dump))).rejects.toBeInstanceOf(LedgerUnreadableError);
  });

  it.each(['pgDumpPlainLedger.sql', 'pgDumpPlainAdversarial.sql', 'pgDumpInsertsAdversarial.sql'])(
    'reads %s the same whatever the chunk boundaries', (name) => {
      const text = fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8');
      for (const size of [1, 2, 3, 7, 64, 257]) {
        const parser = pgDumpLedgerParser();
        for (let i = 0; i < text.length; i += size) parser.feed(text.slice(i, i + size));
        expect(parser.end()).toEqual(['001_init.js', '366_fix_translated_email_template_placeholders.js']);
      }
    },
  );

  describe('long lines', () => {
    const MiB = 1024 * 1024;
    const LEDGER = 'COPY public.migrations (id, filename) FROM stdin;\n1\t001_init.js\n\\.\n';
    const feedChunked = (parser, parts) => {
      for (const part of parts) for (let i = 0; i < part.length; i += 16 * 1024) parser.feed(part.slice(i, i + 16 * 1024));
      return parser.end();
    };

    it.each([
      ['a COPY row of another table', (v) => ['COPY public.events (id, title) FROM stdin;\n1\t', v, '\n\\.\n']],
      ['an INSERT of another table', (v) => ['INSERT INTO public.events VALUES (1, \'', v, '\');\n']],
    ])('skips %s of 32 MiB in linear time without buffering it', (_label, rows) => {
      const parser = pgDumpLedgerParser();
      const started = Date.now();
      expect(feedChunked(parser, [...rows('x'.repeat(32 * MiB)), LEDGER])).toEqual(['001_init.js']);
      expect(Date.now() - started).toBeLessThan(3000);
      // Nothing beyond the head of a line (256 characters) was held.
      expect(parser.maxBuffered).toBeLessThanOrEqual(256);
    });

    it('is unreadable when a ledger row or ledger INSERT passes the 1 MiB cap', () => {
      const row = pgDumpLedgerParser();
      expect(() => feedChunked(row, [`COPY public.migrations (id, filename) FROM stdin;\n1\t${'x'.repeat(2 * MiB)}.js\n\\.\n`]))
        .toThrow(LedgerUnreadableError);
      expect(row.maxBuffered).toBeLessThanOrEqual(MiB + 16 * 1024);

      const insert = pgDumpLedgerParser();
      expect(() => feedChunked(insert, [`INSERT INTO public.migrations (id, filename) VALUES (1, '${'x'.repeat(2 * MiB)}.js');\n`]))
        .toThrow(LedgerUnreadableError);
      expect(insert.maxBuffered).toBeLessThanOrEqual(MiB + 16 * 1024);
    });
  });

  it('finds the filename column wherever the COPY column list puts it, quoted or not', async () => {
    const dump = 'COPY "public"."migrations" ("filename", id) FROM stdin;\n001_init.js\t1\n\\.\n';
    expect(await readPgDumpLedger(fromText(dump))).toEqual(['001_init.js']);
  });

  it('reads --column-inserts and multi-row --inserts dumps', async () => {
    const columnInserts = [
      'INSERT INTO public.migrations (id, filename, executed_at) VALUES (1, \'001_init.js\', \'2025-01-01 00:00:00+00\');',
      'INSERT INTO public.migrations (id, filename, executed_at) VALUES (2, \'002_it\'\'s.js\', NULL);',
    ].join('\n');
    expect(await readPgDumpLedger(fromText(columnInserts))).toEqual(['001_init.js', '002_it\'s.js']);

    const inserts = [
      'CREATE TABLE public.migrations (',
      '    id integer NOT NULL,',
      '    filename character varying(255) NOT NULL',
      ');',
      'INSERT INTO public.migrations VALUES (1, \'001_init.js\'), (2, \'002_b.js\');',
    ].join('\n');
    expect(await readPgDumpLedger(fromText(inserts))).toEqual(['001_init.js', '002_b.js']);

    // --rows-per-insert puts every tuple on its own line.
    const rowsPerInsert = 'INSERT INTO public.migrations (id, filename) VALUES\n\t(1, \'001_init.js\'),\n\t(2, \'002_b.js\');\n';
    expect(await readPgDumpLedger(fromText(rowsPerInsert))).toEqual(['001_init.js', '002_b.js']);
  });

  it('is an empty ledger for an empty table, and null for a dump without one', async () => {
    expect(await readPgDumpLedger(fromText('CREATE TABLE public.migrations (\n    filename text\n);\n'))).toEqual([]);
    expect(await readPgDumpLedger(fromText('COPY public.events (id) FROM stdin;\n1\n\\.\n'))).toBeNull();
  });

  it('refuses to guess on a truncated block or a custom-format archive', async () => {
    await expect(readPgDumpLedger(fromText('COPY public.migrations (id, filename) FROM stdin;\n1\t001_init.js\n')))
      .rejects.toBeInstanceOf(LedgerUnreadableError);
    await expect(readPgDumpLedger(fromText('PGDMP\u0001\u000e\u0000binary')))
      .rejects.toBeInstanceOf(LedgerUnreadableError);
  });
});

describe('readDumpLedger', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dump-ledger-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('gunzips a .sql.gz PostgreSQL dump', async () => {
    const file = path.join(dir, 'pg.sql.gz');
    fs.writeFileSync(file, zlib.gzipSync(PLAIN_DUMP));
    expect(await readDumpLedger(file, 'postgresql')).toHaveLength(3);
  });

  it('reads a SQLite dump read-only, plain or gzipped, and leaves no expanded copy behind', async () => {
    const file = path.join(dir, 'sqlite.sql');
    const source = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true });
    try {
      await source.schema.createTable('migrations', (t) => { t.increments('id'); t.string('filename'); t.timestamp('executed_at'); });
      await source('migrations').insert([
        { filename: '001_init.js', executed_at: new Date(0).toISOString() },
        { filename: '254_fix_translated_email_template_placeholders.js', executed_at: new Date(0).toISOString() },
      ]);
    } finally { await source.destroy(); }
    const before = fs.readFileSync(file);

    expect(await readDumpLedger(file, 'sqlite')).toEqual(['001_init.js', '254_fix_translated_email_template_placeholders.js']);
    expect(fs.readFileSync(file).equals(before)).toBe(true);

    const gz = path.join(dir, 'sqlite.sql.gz');
    fs.writeFileSync(gz, zlib.gzipSync(before));
    expect(await readDumpLedger(gz, 'sqlite')).toHaveLength(2);
    expect(fs.readdirSync(dir).filter(name => name.startsWith('ledger-check-'))).toEqual([]);
  });

  describe('under RESTORE_MAX_DECOMPRESSED_BYTES', () => {
    afterEach(() => { delete process.env.RESTORE_MAX_DECOMPRESSED_BYTES; });

    it('stops gunzipping a PostgreSQL dump at the cap', async () => {
      const file = path.join(dir, 'big-pg.sql.gz');
      fs.writeFileSync(file, zlib.gzipSync(PLAIN_DUMP + `-- ${'x'.repeat(256 * 1024)}\n`));
      process.env.RESTORE_MAX_DECOMPRESSED_BYTES = String(64 * 1024);
      await expect(readDumpLedger(file, 'postgresql')).rejects.toBeInstanceOf(DecompressLimitError);
    });

    it('stops expanding a SQLite dump at the cap and removes the partial copy', async () => {
      const scratch = fs.mkdtempSync(path.join(dir, 'scratch-'));
      const file = path.join(dir, 'big-sqlite.sql.gz');
      fs.writeFileSync(file, zlib.gzipSync(Buffer.alloc(1024 * 1024)));
      process.env.RESTORE_MAX_DECOMPRESSED_BYTES = String(64 * 1024);
      await expect(readDumpLedger(file, 'sqlite', { scratchDir: scratch })).rejects.toBeInstanceOf(DecompressLimitError);
      expect(fs.readdirSync(scratch)).toEqual([]);
    });
  });

  it('is null for a SQLite database without a ledger, unreadable for a file that is none', async () => {
    const empty = path.join(dir, 'empty.sql');
    const source = knex({ client: 'sqlite3', connection: { filename: empty }, useNullAsDefault: true });
    try { await source.schema.createTable('events', t => t.increments('id')); } finally { await source.destroy(); }
    expect(await readDumpLedger(empty, 'sqlite')).toBeNull();

    const junk = path.join(dir, 'junk.sql');
    fs.writeFileSync(junk, 'not a SQLite database');
    await expect(readDumpLedger(junk, 'sqlite')).rejects.toBeInstanceOf(LedgerUnreadableError);
  });
});
