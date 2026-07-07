/**
 * Test harness for CRM integration tests.
 *
 * Boots a temp-SQLite database, runs every `migrations/core/*.up()`
 * directly (bypassing knex's Migrator — its exclusive write lock
 * deadlocks 001_init's nested `initializeDatabase()` call), and
 * exposes a small helper for seeding the minimal row set that the
 * quote/contract/invoice services need to operate.
 *
 * Usage:
 *
 *   const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
 *
 *   beforeAll(async () => {
 *     ({ db, cleanup } = await bootCrmDb());
 *     ({ adminId, customerId } = await seedMinimal(db));
 *   });
 *   afterAll(async () => { await cleanup(); });
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcrypt');

async function runCoreMigrations(db) {
  await db.schema.createTable('migrations', (t) => {
    t.increments('id').primary();
    t.string('filename').unique().notNullable();
    t.timestamp('applied_at').defaultTo(db.fn.now());
  });

  const coreDir = path.resolve(__dirname, '..', '..', '..', 'migrations', 'core');
  const files = (await fs.promises.readdir(coreDir))
    .filter((f) => f.endsWith('.js'))
    .sort();

  for (const f of files) {
    const mod = require(path.join(coreDir, f));
    if (typeof mod.up === 'function') {
      await mod.up(db);
    }
    await db('migrations').insert({ filename: f });
  }
}

/**
 * Boot a clean test DB. Returns { db, cleanup, tmpDir }.
 * Caller must invoke cleanup() in afterAll to release the SQLite file
 * and the temp directory.
 */
async function bootCrmDb() {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-crm-'));
  process.env.NODE_ENV = 'test';
  process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'crm.db');
  process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
  await fs.promises.mkdir(process.env.STORAGE_PATH, { recursive: true });

  // No jest.resetModules() — every service the test later requires
  // must share THIS db instance. Two module copies on one SQLite file
  // each open their own knex pool and the SQLite write lock deadlocks
  // the second one acquiring a connection. Caller is responsible for
  // setting TEST_DATABASE_PATH before the first require of db.js
  // (which knexfile reads at module-init time); bootCrmDb only works
  // when invoked before any service import.
  const { db } = require('../../../src/database/db');

  await runCoreMigrations(db);

  return {
    db,
    tmpDir,
    cleanup: async () => {
      try { await db.destroy(); } catch (_) {}
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/**
 * Seed the minimal row set that quote/contract/invoice services
 * dereference on creation: an admin user, an active customer, a
 * business_profile row, and the app_settings keys the services read.
 *
 * Returns the ids the caller will pass into service calls.
 */
async function seedMinimal(db) {
  const passwordHash = await bcrypt.hash('test-pass', 4); // low rounds = fast

  const adminInsert = await db('admin_users').insert({
    username: 'tester', email: 'tester@example.com',
    password_hash: passwordHash, must_change_password: false,
    created_at: new Date(),
  }).returning('id');
  const adminId = adminInsert[0]?.id ?? adminInsert[0];

  // business_profile is a singleton; the row is seeded by migration 107
  // for fresh installs. Defensive: insert if missing.
  const profile = await db('business_profile').first();
  if (!profile) {
    await db('business_profile').insert({
      legal_name: 'Test Studio',
      default_currency: 'CHF',
      default_locale: 'de',
    });
  }

  const customerInsert = await db('customer_accounts').insert({
    email: 'customer@example.com',
    display_name: 'Test Customer',
    password_hash: passwordHash,
    preferred_language: 'de',
    is_active: 1,
    created_at: new Date(),
  }).returning('id');
  const customerId = customerInsert[0]?.id ?? customerInsert[0];

  return { adminId, customerId };
}

// ---------------------------------------------------------------------
// Route-test helpers (#570) — building blocks for the CRM HTTP layer
// tests. Kept here so every supertest suite shares the same minting +
// app-wiring shape and a refactor lands in one place.
// ---------------------------------------------------------------------

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const cookieParser = require('cookie-parser');

/**
 * Promote a seeded admin into a role (default `super_admin`) so
 * `requirePermission(...)` checks pass. seedMinimal creates an admin
 * without a role — that's good for negative tests (expect 403) but
 * happy-path tests need the role assignment.
 *
 * Returns the role id the admin was assigned to.
 */
async function assignAdminRole(db, adminId, roleName = 'super_admin') {
  const role = await db('roles').where({ name: roleName }).first();
  if (!role) {
    throw new Error(`Role '${roleName}' not seeded — check the test DB`);
  }
  await db('admin_users').where({ id: adminId }).update({ role_id: role.id });
  return role.id;
}

/**
 * Mint an admin JWT in the same shape adminAuth middleware expects.
 * The tests inject this via `Authorization: Bearer <token>`.
 */
function mintAdminToken(adminId, { expiresIn = '1h', extraClaims = {} } = {}) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';
  return jwt.sign(
    { id: adminId, type: 'admin', iat: Math.floor(Date.now() / 1000), ...extraClaims },
    process.env.JWT_SECRET,
    { expiresIn, issuer: 'picpeak-auth' }
  );
}

/**
 * Insert a row into one of the public-token tables for testing the
 * loadActionToken guard outcomes. Returns the generated 64-hex token.
 *
 * Usage:
 *   await createPublicToken(db, 'quote_action_tokens', { quote_id: q.id });
 *   await createPublicToken(db, 'quote_action_tokens', { quote_id: q.id, expires_at: pastDate });
 *   await createPublicToken(db, 'quote_action_tokens', { quote_id: q.id, used_at: new Date() });
 *   await createPublicToken(db, 'quote_action_tokens', { quote_id: q.id, expires_at: null });
 */
async function createPublicToken(db, tableName, opts = {}) {
  const token = opts.token || crypto.randomBytes(32).toString('hex');
  const expiresAt = opts.expires_at === null
    ? null
    : (opts.expires_at || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  // Serialise Date → ISO string. Bare Date objects round-tripped
  // inconsistently through knex+SQLite — sometimes as epoch ms,
  // sometimes via .toString() → literal "[object Object]" which then
  // parses back to NaN and silently defeats the expiry guard.
  const toStorable = (v) => (v instanceof Date ? v.toISOString() : v);
  const row = {
    ...opts,
    token,
    expires_at: toStorable(expiresAt),
    created_at: toStorable(new Date()),
  };
  await db(tableName).insert(row);
  return token;
}

/**
 * Build an Express app with the requested route file mounted. Mirrors
 * the production app's middleware shape (json + cookies) but skips
 * everything else (CORS, helmet, rate limiters) — route tests pin the
 * handler's contract, not the surrounding cross-cutting concerns.
 *
 * Example:
 *   const app = buildRouteApp('/api/public/quotes',
 *     require('../../src/routes/publicQuotes'));
 */
function buildRouteApp(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(mount, router);
  // Catch-all error handler. Mirrors the real middleware/errorHandler:
  // AppError subclasses (ValidationError, NotFoundError, etc.) use
  // `.statusCode` (NOT `.status` — getting that wrong silently maps
  // every 400 / 404 / 410 to 500 in tests).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || err.status || 500;
    res.status(statusCode).json({
      error: err.message || 'Internal error',
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
    });
  });
  return app;
}

module.exports = {
  bootCrmDb,
  seedMinimal,
  assignAdminRole,
  mintAdminToken,
  createPublicToken,
  buildRouteApp,
};
