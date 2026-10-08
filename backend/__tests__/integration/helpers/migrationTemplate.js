'use strict';

/**
 * A freshly migrated SQLite file that bootCrmDb() copies instead of running
 * every core migration again. Running the chain cost every DB suite a couple
 * of seconds (237 migrations and growing); a file copy costs milliseconds.
 *
 * Templates live in a directory the `db` jest project's globalSetup creates
 * for this run and its globalTeardown removes, so a template never outlives
 * the migrations it was built from. Without that directory (a run that skips
 * the globalSetup, or Postgres) bootCrmDb runs the migrations as before.
 *
 * A few migrations seed rows from environment variables (SMTP_*, EMAIL_FROM,
 * ...), and some suites set those before booting. Each distinct set of values
 * gets its own template, built once by whichever worker asks first.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CORE_DIR = path.resolve(__dirname, '..', '..', '..', 'migrations', 'core');
const BUILD_SCRIPT = path.join(__dirname, 'buildMigrationTemplate.js');
const TEMPLATE_DIR_ENV = 'PICPEAK_TEST_TEMPLATE_DIR';
const BUILD_WAIT_MS = 120000;

let envNames = null;

// Every process.env name a core migration reads, so a new migration that
// seeds from the environment is keyed without anyone updating a list here.
// STORAGE_PATH is left out: only backfills of existing rows read it, a fresh
// database has none, and every suite points it at its own temp directory.
function migrationEnvNames() {
  if (!envNames) {
    const names = new Set();
    for (const f of fs.readdirSync(CORE_DIR)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(CORE_DIR, f), 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
    }
    names.delete('STORAGE_PATH');
    envNames = [...names].sort();
  }
  return envNames;
}

function templatePath(dir, env) {
  const snapshot = migrationEnvNames().map((name) => [name, env[name] ?? null]);
  const key = crypto.createHash('sha1').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
  return path.join(dir, `${key}.db`);
}

function build(target, env) {
  const tmp = `${target}.${process.pid}.tmp`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BUILD_SCRIPT, tmp], { env, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        fs.rmSync(tmp, { force: true });
        reject(new Error(`Building the migration template failed:\n${stderr || err.message}`));
        return;
      }
      fs.renameSync(tmp, target);
      resolve(target);
    });
  });
}

/**
 * Path of a migrated template matching `env`, building it if needed, or null
 * when bootCrmDb should run the migrations itself.
 */
async function templateFor(env = process.env) {
  const dir = env[TEMPLATE_DIR_ENV];
  if (!dir || env.DATABASE_CLIENT === 'pg') return null;
  // 001_init writes a credentials file when ADMIN_PASSWORD is set. A copied
  // template would skip that side effect, so those suites migrate for real.
  if (env.ADMIN_PASSWORD) return null;

  const target = templatePath(dir, env);
  if (fs.existsSync(target)) return target;

  const lock = `${target}.lock`;
  try {
    fs.closeSync(fs.openSync(lock, 'wx'));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Another worker is building this template; wait for it. If it gives up
    // (lock gone, no file), migrate in-process so the real error surfaces.
    const deadline = Date.now() + BUILD_WAIT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(target)) return target;
      if (!fs.existsSync(lock)) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  try {
    return await build(target, env);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

module.exports = { templateFor, TEMPLATE_DIR_ENV };
