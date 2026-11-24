'use strict';

/**
 * Loading a plain pg_dump file with psql so that the first failing statement
 * stops the load and fails the caller. Used by the restore and its rollback
 * (restoreService).
 */

const fsp = require('fs').promises;
const path = require('path');

// pg_dump writes its session settings at the top of a plain dump, before the
// first object. A newer pg_dump writes settings an older server does not have
// (pg_dump 17 always writes `SET transaction_timeout = 0;`, which PostgreSQL
// 15 and 16 reject), and with ON_ERROR_STOP that line alone would fail a dump
// that loads fine otherwise. The scan reads comments, `\` meta lines, SET and
// set_config lines from the top, in either case as the server reads them, and
// stops at the first other statement (for a dump whose first object is a
// table, that takes in its `-- Name: …` comment and its `SET
// default_tablespace` lines too, which every server has). It never reads more
// than this many bytes.
const HEADER_SCAN_BYTES = 64 * 1024;
const HEADER_LINE = /^(?:--.*|\\.*|SET\s.*|SELECT pg_catalog\.set_config\(.*|\s*)$/i;
const HEADER_SET = /^SET\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=|\s+TO\s)/i;
const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function contained(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Comments out, in place, every header `SET name = ...;` whose setting the
// target server does not have, by turning `SET` into `-- ` (same length, so
// nothing after the header moves and psql's line numbers stay right). Only
// a private copy in the work directory is ever edited. Dotted names are
// custom placeholders any server accepts, so they are never asked about.
// `findUnknown(names)` resolves to the subset the server does not have.
// Returns the names it commented out.
async function neutraliseUnknownSettings(file, workDir, findUnknown) {
  if (!contained(path.resolve(workDir), path.resolve(file))) {
    throw new Error('Refusing to edit a dump outside the work directory');
  }
  // The copy is ours but may have arrived read-only: an rsync dump keeps the
  // remote file's mode (rsync runs without --perms) and is only renamed into
  // place. Without this an 0444 dump fails here, after the DROP.
  await fsp.chmod(file, 0o600);
  const handle = await fsp.open(file, 'r+');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_SCAN_BYTES), 0, HEADER_SCAN_BYTES, 0);
    const head = buffer.subarray(0, bytesRead);
    const sets = [];
    let offset = 0;
    while (offset < head.length) {
      const end = head.indexOf(0x0a, offset);
      if (end === -1) break; // a line cut off by the scan window is not judged
      const line = head.subarray(offset, end).toString('utf8').replace(/\r$/, '');
      if (!HEADER_LINE.test(line)) break; // first other statement: the scan is over
      const match = HEADER_SET.exec(line);
      if (match) sets.push({ name: match[1].toLowerCase(), offset });
      offset = end + 1;
    }
    if (sets.length === 0) return [];
    const unknown = new Set(await findUnknown([...new Set(sets.map((s) => s.name))]));
    const skipped = [];
    for (const set of sets) {
      if (!unknown.has(set.name)) continue;
      await handle.write(Buffer.from('-- '), 0, 3, set.offset);
      skipped.push(set.name);
    }
    return skipped;
  } finally {
    await handle.close();
  }
}

// The first ERROR/FATAL lines psql wrote (with -f they name file and line),
// instead of the whole stderr.
function psqlErrorSummary(error) {
  return String(error.stderr || error.message).trim().split('\n')
    .filter((l) => /ERROR|FATAL/.test(l)).slice(0, 3).join(' ') || error.message;
}

// Asks the server itself, so an alias it accepts counts as known too
// (pg_settings lists canonical names only). The names come from HEADER_SET,
// and each is checked again here before it becomes a literal, so this does
// not rest on that regex alone. (psql does not interpolate -v variables in
// a -c command, so a psql variable is not an option here.)
function unknownSettingsOf(target, env) {
  return async (names) => {
    const { spawnAsync } = require('./safeExec');
    if (!names.every((name) => SETTING_NAME.test(name))) throw new Error('Unexpected setting name in the dump header');
    const list = names.map((name) => `'${name}'`).join(', ');
    const { stdout } = await spawnAsync('psql', ['-X', '-q', '-A', '-t', ...target, '-c',
      `SELECT n FROM unnest(ARRAY[${list}]::text[]) AS n WHERE current_setting(n, true) IS NULL`], { env });
    return stdout.split('\n').map((name) => name.trim()).filter(Boolean);
  };
}

/**
 * Loads `file` (a plain dump, a private copy inside `workDir`) into the
 * database `target` names (psql connection arguments ending in `-d <db>`).
 * Header settings the server lacks are commented out first; every other
 * failing statement stops the load and rejects with psql's error.
 * `singleTransaction` wraps the load in one transaction, so a failed load
 * leaves nothing of the dump behind.
 *
 * Resolves to { skipped }: the header settings that were commented out.
 */
async function loadPlainDump(file, { target, env, workDir, singleTransaction = false }) {
  const { spawnAsync } = require('./safeExec');
  let skipped;
  try {
    skipped = await neutraliseUnknownSettings(file, workDir, unknownSettingsOf(target, env));
  } catch (error) {
    throw new Error(psqlErrorSummary(error));
  }
  // -f rather than stdin, so the statement that stopped the load is named
  // in the error instead of a broken pipe.
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(singleTransaction ? ['--single-transaction'] : []), ...target, '-f', file];
  try {
    await spawnAsync('psql', args, { env });
  } catch (error) {
    throw new Error(psqlErrorSummary(error));
  }
  return { skipped };
}

module.exports = { loadPlainDump, neutraliseUnknownSettings, psqlErrorSummary };
