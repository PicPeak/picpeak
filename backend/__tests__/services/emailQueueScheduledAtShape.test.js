/**
 * Every writer of a pending email_queue row sets scheduled_at itself
 * (issue 1670).
 *
 * The column defaults to CURRENT_TIMESTAMP. On SQLite that is text, the
 * processor compares the column against a number, and SQLite orders every
 * number below every text — a row left to the default was never due. Rows
 * with an explicit value (a Date, milliseconds, or NULL) always were. So the
 * rule is: a pending row is written with scheduled_at, NULL when it should go
 * out at once.
 *
 * Under Jest a Date binds as the literal "[object Object]" (CLAUDE.md), so
 * only the NULL shape is asserted at the database here; migration 236's test
 * exercises the due predicate with numbers.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-queue-shape-'));
process.env.STORAGE_PATH = tmp;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-validation';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SRC = path.join(__dirname, '../../src');
// Every `db('email_queue').insert({ ... status: 'pending' ... })` in the
// backend. adminEmail.js inserts an already-sent manual message and is not a
// queue writer.
const PENDING_WRITERS = [
  'services/emailProcessor.js',
  'services/eventCreationService.js',
  'services/projectService.js',
  'services/newsletterService.js',
  'routes/adminEvents/crud.js',
];

describe('every pending-row writer names scheduled_at', () => {
  test.each(PENDING_WRITERS)('%s', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    // Each insert statement that queues a pending row — from `insert(` to the
    // `;` that ends it — must mention scheduled_at. queueEmail builds its row
    // in a `const row = { ... };` literal first, so that one is read instead.
    const statements = [...src.matchAll(/email_queue'\)\.insert\(([\s\S]*?);\n/g)].map((m) => m[1]);
    expect(statements.length).toBeGreaterThan(0);
    const bodies = statements.map((stmt) => (/^\s*row\s*\)?$/.test(stmt.replace(/\)\.returning\([^)]*\)/, ''))
      ? src.match(/const row = \{([\s\S]*?)\n\s*\};/)[1]
      : stmt));
    const pendingBodies = bodies.filter((body) => /status:\s*'pending'/.test(body));
    expect(pendingBodies.length).toBeGreaterThan(0);
    // The key itself, not a comment that names it.
    for (const body of pendingBodies) expect(body).toMatch(/scheduled_at\s*:/);
  });

  test('no writer leaves the column to its default any more', () => {
    for (const rel of PENDING_WRITERS) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect(src).not.toMatch(/scheduled_at will use default/);
    }
  });
});

describe('queueEmail on SQLite', () => {
  let db; let cleanup; let queueEmail;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    ({ queueEmail } = require('../../src/services/emailProcessor'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the column default really is text on this engine', async () => {
    await db('email_queue').insert({
      recipient_email: 'default@example.com', email_type: 'probe', status: 'pending', created_at: Date.now(),
    });
    const row = await db('email_queue').where({ email_type: 'probe' })
      .first(db.raw('typeof(scheduled_at) as t'));
    expect(row.t).toBe('text');
  });

  test('an ordinary email is stored with scheduled_at NULL, so the processor finds it', async () => {
    await queueEmail(null, 'plain@example.com', 'gallery_created', { event_name: 'x' });
    const row = await db('email_queue').where({ recipient_email: 'plain@example.com' })
      .first(db.raw('typeof(scheduled_at) as t'), 'status');
    expect(row.status).toBe('pending');
    expect(row.t).toBe('null');
  });
});
