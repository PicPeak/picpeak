/**
 * The restore test's drill loads a dump with psql ON_ERROR_STOP. pg_dump 17
 * and later write `SET transaction_timeout = 0;` into every plain dump, and
 * PostgreSQL 15 and 16 do not have that setting, so the drill failed every
 * backup of a PostgreSQL 15 install made with the image's newer client (the
 * Alpine postgresql-client is 18), though a real restore (no ON_ERROR_STOP)
 * steps over the line. The drill now comments out header settings the server
 * does not have, and still stops on any other error.
 *
 * Gated on PICPEAK_PG_TEST_URL like the other real-Postgres restore suites:
 *   PICPEAK_PG_TEST_URL=postgres://picpeak:pw@127.0.0.1:5432/picpeak_test \
 *     npx jest __tests__/integration/backupVerificationDrillPg.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const knexLib = require('knex');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

function pgEnv(database) {
  const url = new URL(PG_URL);
  return {
    DATABASE_CLIENT: 'pg', DB_HOST: url.hostname, DB_PORT: url.port || '5432',
    DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password), DB_NAME: database,
  };
}

// Run `fn` with the knexfile, db and services resolving to `database`.
async function withDatabase(database, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, pgEnv(database));
  try {
    let result;
    await jest.isolateModulesAsync(async () => { result = await fn(); });
    return result;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

maybe('restore-test drill on PostgreSQL', () => {
  let admin;
  const databases = [];
  const createDatabase = async (prefix) => {
    const name = `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
    await admin.raw('CREATE DATABASE ??', [name]);
    databases.push(name);
    return name;
  };

  beforeAll(() => { admin = knexLib({ client: 'pg', connection: PG_URL }); });
  afterAll(async () => {
    for (const name of databases) {
      await admin.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [name]).catch(() => {});
      await admin.raw('DROP DATABASE IF EXISTS ??', [name]).catch(() => {});
    }
    await admin.destroy();
  });

  describe('drill load of a dump from a newer pg_dump', () => {
    let workDir;
    beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-verify-pg-')); });
    afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

    it('loads it, naming the settings it skipped, and still stops on a real error', async () => {
      const serverVersion = Number((await admin.raw('SHOW server_version_num')).rows[0].server_version_num);
      const serverHasIt = serverVersion >= 170000;
      const header = [
        '--', '-- PostgreSQL database dump', '--', '',
        '-- Dumped from database version 15.10', '-- Dumped by pg_dump version 18.1', '',
        'SET statement_timeout = 0;', 'SET lock_timeout = 0;', 'SET idle_in_transaction_session_timeout = 0;',
        'SET transaction_timeout = 0;', 'SET client_encoding = \'UTF8\';', 'SET standard_conforming_strings = on;',
        'SELECT pg_catalog.set_config(\'search_path\', \'\', false);', 'SET check_function_bodies = false;',
        'SET xmloption = content;', 'SET client_min_messages = warning;', 'SET row_security = off;', '',
      ];
      const body = ['CREATE TABLE public.drill_probe (id integer);', 'INSERT INTO public.drill_probe VALUES (7);', ''];
      const dump = path.join(workDir, 'dump');

      const database = await createDatabase('picpeak_drill_probe');
      fs.writeFileSync(dump, [...header, ...body].join('\n'));
      const loaded = await withDatabase(database, () => {
        const { _internal } = require('../../src/services/backupVerificationWorker');
        return _internal.loadPostgres({ workDir }, dump);
      });
      expect(loaded.skipped).toEqual(serverHasIt ? [] : ['transaction_timeout']);
      const url = new URL(PG_URL);
      url.pathname = `/${database}`;
      const probe = knexLib({ client: 'pg', connection: url.toString() });
      try {
        expect((await probe('drill_probe').select('id')).map((r) => r.id)).toEqual([7]);
      } finally {
        await probe.destroy();
      }

      // Only header settings are forgiven: a broken statement still fails.
      const broken = await createDatabase('picpeak_drill_probe');
      fs.writeFileSync(dump, [...header, 'CREATE TABLE public.drill_probe (id integer);', 'SELECT no_such_function();', ''].join('\n'));
      await expect(withDatabase(broken, () => {
        const { _internal } = require('../../src/services/backupVerificationWorker');
        return _internal.loadPostgres({ workDir }, dump);
      })).rejects.toThrow(/no_such_function/);
    }, 60000);
  });
});
