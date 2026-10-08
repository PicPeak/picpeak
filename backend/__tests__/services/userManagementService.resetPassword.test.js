/**
 * GHSA-h4w8-57xq-53fx entropy half: resetAdminPassword used to mint the
 * emailed temp password with generateReadablePassword() — 10 adjectives x
 * 10 nouns x crypto.randomInt(1000,9999) x 5 specials, ~2^21 possibilities,
 * brute-forceable. It now uses generateSecurePassword(16) (90-char charset),
 * same as every other security-sensitive password path in this file.
 *
 * Verified against a real SQLite DB (full core-migration set) so the
 * emailed plaintext, the stored hash, and must_change_password are all
 * checked end to end rather than against a mock.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// bootCrmDb() sets TEST_DATABASE_PATH itself, but only in time for requires
// that happen AFTER it runs (inside beforeAll). userManagementService.js
// requires database/db.js at module load — i.e. before beforeAll — so that
// connection has to be pointed at a fresh, unused test DB up front, or it
// falls back to the shared default path and collides with whatever another
// test file already migrated onto it. Same workaround as
// userManagementService.activateDelete.test.js.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-reset-pw-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'reset-pw-test-secret';

const bcrypt = require('bcrypt');

const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');
const userManagementService = require('../../src/services/userManagementService');
const { decryptEmailData, isEncryptedEmailData } = require('../../src/utils/emailQueueEncryption');

// The wordlist generateReadablePassword() used to produce:
//   <Adjective><Noun><4 digits><1 special>, e.g. "SwiftEagle4821!"
const READABLE_WORDLIST_PATTERN = /^(Swift|Bright|Strong|Happy|Clever|Brave|Noble|Quick|Sharp|Bold)(Eagle|Mountain|River|Thunder|Forest|Ocean|Falcon|Dragon|Phoenix|Tiger)\d{4}[!@#$%]$/;

describe('userManagementService.resetAdminPassword (GHSA-h4w8-57xq-53fx)', () => {
  let db;
  let cleanup;
  let actorId;
  let targetId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: actorId } = await seedMinimal(db));
    await assignAdminRole(db, actorId, 'super_admin');

    const editor = await db('roles').where({ name: 'editor' }).first();
    const targetInsert = await db('admin_users').insert({
      username: 'reset-target', email: 'reset-target@example.com',
      password_hash: await bcrypt.hash('old-password', 4),
      role_id: editor?.id || null,
      is_active: 1, must_change_password: false, created_at: new Date().toISOString(),
    }).returning('id');
    targetId = targetInsert[0]?.id ?? targetInsert[0];
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('generates a high-entropy password, not one drawn from the adjective/noun wordlist', async () => {
    const before = await db('admin_users').where({ id: targetId }).first();

    await userManagementService.resetAdminPassword(targetId, actorId);

    const emailRow = await db('email_queue')
      .where({ recipient_email: 'reset-target@example.com', email_type: 'admin_password_reset' })
      .orderBy('id', 'desc')
      .first();
    expect(emailRow).toBeDefined();
    const storedEmailData = JSON.parse(emailRow.email_data);
    expect(isEncryptedEmailData(storedEmailData)).toBe(true);
    const emailData = decryptEmailData(emailRow.email_type, storedEmailData, emailRow.recipient_email);
    const newPassword = emailData.new_password;

    // generateSecurePassword(16): fixed 16-char length, not the wordlist's
    // variable-length "WordWord####!" shape.
    expect(newPassword).toHaveLength(16);
    expect(newPassword).not.toMatch(READABLE_WORDLIST_PATTERN);
    // generateSecurePassword guarantees at least one of each character class.
    expect(newPassword).toMatch(/[a-z]/);
    expect(newPassword).toMatch(/[A-Z]/);
    expect(newPassword).toMatch(/[0-9]/);
    expect(newPassword).toMatch(/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/);

    // The emailed plaintext actually matches what got persisted.
    const after = await db('admin_users').where({ id: targetId }).first();
    expect(after.password_hash).not.toBe(before.password_hash);
    await expect(bcrypt.compare(newPassword, after.password_hash)).resolves.toBe(true);
  });

  it('sets must_change_password so the enforcement backstop kicks in on next login', async () => {
    await db('admin_users').where({ id: targetId }).update({ must_change_password: false });

    await userManagementService.resetAdminPassword(targetId, actorId);

    const after = await db('admin_users').where({ id: targetId }).first();
    expect(after.must_change_password === true || after.must_change_password === 1).toBe(true);
  });
});
