/**
 * The header neutralisation the PostgreSQL restore runs before it loads a
 * dump with ON_ERROR_STOP (issue 2482): only header settings the server does
 * not have are commented out, nothing else moves.
 */

const path = require('path');

describe('pgDumpLoad: settings a newer pg_dump writes that the target server lacks', () => {
  const fs = require('fs').promises;
  const os = require('os');
  const { neutraliseUnknownSettings } = require('../../src/utils/pgDumpLoad');

  // The preamble pg_dump 17 writes, dumped from a PostgreSQL 15 server.
  const HEADER = [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    '-- Dumped from database version 15.10',
    '-- Dumped by pg_dump version 17.2',
    '',
    'SET statement_timeout = 0;',
    'SET lock_timeout = 0;',
    'SET idle_in_transaction_session_timeout = 0;',
    'SET transaction_timeout = 0;',
    'SET client_encoding = \'UTF8\';',
    'SET standard_conforming_strings = on;',
    'SELECT pg_catalog.set_config(\'search_path\', \'\', false);',
    'SET check_function_bodies = false;',
    'SET xmloption = content;',
    'SET client_min_messages = warning;',
    'SET row_security = off;',
    '',
  ];
  const PG15 = new Set(['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'client_encoding',
    'standard_conforming_strings', 'check_function_bodies', 'xmloption', 'client_min_messages', 'row_security',
    'default_tablespace', 'search_path']);

  const unknownTo = (known) => async (names) => names.filter((n) => !known.has(n));
  let workDir;
  beforeEach(async () => { workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pgdumpload-settings-')); });
  afterEach(async () => { await fs.rm(workDir, { recursive: true, force: true }); });

  const write = async (lines) => {
    const file = path.join(workDir, 'dump.plain');
    await fs.writeFile(file, lines.join('\n'));
    return file;
  };

  it('comments out only the unknown header setting, keeping every byte offset', async () => {
    const body = ['CREATE TABLE public.t (id integer);', 'SET transaction_timeout = 0;', 'COPY public.t (id) FROM stdin;', '1', '\\.', ''];
    const file = await write([...HEADER, ...body]);
    const before = await fs.readFile(file, 'utf8');

    expect(await neutraliseUnknownSettings(file, workDir, unknownTo(PG15))).toEqual(['transaction_timeout']);

    const after = await fs.readFile(file, 'utf8');
    expect(after.length).toBe(before.length);
    // Exactly one line differs, and only in its first three bytes.
    const changed = after.split('\n').map((l, i) => [l, before.split('\n')[i]]).filter(([a, b]) => a !== b);
    expect(changed).toEqual([['--  transaction_timeout = 0;', 'SET transaction_timeout = 0;']]);
    expect(after).toContain('\nSET lock_timeout = 0;\n');
    // The body is never touched, not even a line that looks like the header.
    expect(after.endsWith(body.join('\n'))).toBe(true);
  });

  it('changes nothing when the server knows every setting', async () => {
    const file = await write([...HEADER, 'CREATE TABLE public.t (id integer);', '']);
    const before = await fs.readFile(file);
    expect(await neutraliseUnknownSettings(file, workDir, unknownTo(new Set([...PG15, 'transaction_timeout'])))).toEqual([]);
    expect((await fs.readFile(file)).equals(before)).toBe(true);
  });

  it('asks the server only about header names, once each, never about dotted ones', async () => {
    const asked = [];
    const file = await write([...HEADER, 'SET my_ext.mode = \'x\';', 'SET lock_timeout = 0;', 'CREATE TABLE public.t (id integer);', 'SET late_setting = 1;', '']);
    await neutraliseUnknownSettings(file, workDir, async (names) => { asked.push(...names); return []; });
    expect(asked).toEqual(['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout',
      'client_encoding', 'standard_conforming_strings', 'check_function_bodies', 'xmloption', 'client_min_messages', 'row_security']);
  });

  it('handles the TO form, the \\restrict line and CRLF, and leaves dotted custom settings alone', async () => {
    const file = await write([
      '\\restrict abc123', '-- header', 'SET transaction_timeout TO 0;\r', 'SET my_ext.mode = \'x\';',
      'SET SESSION AUTHORIZATION DEFAULT;', 'CREATE TABLE public.t (id integer);', '',
    ]);
    expect(await neutraliseUnknownSettings(file, workDir, unknownTo(PG15))).toEqual(['transaction_timeout']);
    const after = await fs.readFile(file, 'utf8');
    expect(after).toContain('--  transaction_timeout TO 0;\r\n');
    expect(after).toContain('SET my_ext.mode = \'x\';');
    expect(after).toContain('SET SESSION AUTHORIZATION DEFAULT;');
  });

  it('judges a lowercase header set like an uppercase one, instead of ending the scan on it', async () => {
    const file = await write(['-- header', 'set lock_timeout = 0;', 'set transaction_timeout = 0;', 'SET row_security = off;',
      'CREATE TABLE public.t (id integer);', '']);
    expect(await neutraliseUnknownSettings(file, workDir, unknownTo(PG15))).toEqual(['transaction_timeout']);
    const after = await fs.readFile(file, 'utf8');
    expect(after).toContain('\n--  transaction_timeout = 0;\n');
    expect(after).toContain('\nset lock_timeout = 0;\n');
  });

  it('refuses to edit a file outside the work directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pgdumpload-outside-'));
    try {
      const file = path.join(outside, 'dump.plain');
      await fs.writeFile(file, HEADER.join('\n'));
      await expect(neutraliseUnknownSettings(file, workDir, unknownTo(PG15))).rejects.toThrow('outside the work directory');
      expect(await fs.readFile(file, 'utf8')).toBe(HEADER.join('\n'));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
