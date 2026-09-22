#!/usr/bin/env node
/**
 * rotate-evidence-key.js — re-encrypt signing evidence under the current
 * evidence key (#1446).
 *
 * Contract signers' names, email addresses, IP addresses, user agents and
 * decline reasons are stored encrypted, each value naming the key it was
 * written under (`v1:<keyId>:…`). To rotate:
 *
 *   1. Set PICPEAK_EVIDENCE_KEY to the new key, and keep the old one
 *      readable: put it in PICPEAK_EVIDENCE_KEYS_OLD (comma-separated), or —
 *      when the old key was the generated key file — leave that file where it
 *      is: this script renames it to `evidence.key.<keyId>` on its first run.
 *   2. Restart the backend, then run this script. It is resumable and
 *      idempotent: stop it any time and run it again.
 *   3. Keep the old keys until it reports 0 values left under other keys.
 *
 * Usage (inside the running backend container):
 *   docker compose exec backend node scripts/rotate-evidence-key.js --dry-run
 *   docker compose exec backend node scripts/rotate-evidence-key.js
 *
 * Flags:
 *   --dry-run   count values per key id and column, change nothing
 *
 * Every row is rewritten with a conditional update on the value it read, so
 * a signature recorded while the script runs is never overwritten. Only
 * ciphertext changes: the signing log and the certificate hash the plain
 * values' consequences (PDFs, content, events), never these columns, so no
 * hash anywhere changes. Nothing decrypted is ever printed.
 */

const fs = require('fs');
const path = require('path');

const COLUMNS = ['name_enc', 'email_enc', 'ip_enc', 'user_agent_enc', 'decline_reason_enc'];
const BATCH = 200;

/**
 * The generated key file, once PICPEAK_EVIDENCE_KEY has taken over from it,
 * becomes an old key under its id — renamed, never overwritten or deleted.
 * Returns the new file name, or null when there was nothing to rename.
 */
function keepReplacedKeyFile(fieldEncryption) {
  const { getStoragePath } = require('../src/config/storage');
  if (fieldEncryption.keyStatus().source !== 'env') return null;
  const file = path.join(getStoragePath(), fieldEncryption.KEY_FILE);
  if (!fs.existsSync(file)) return null;
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) return null;
  const keyId = require('crypto').createHash('sha256').update(key).digest('hex').slice(0, 8);
  const target = `${file}.${keyId}`;
  if (fs.existsSync(target)) return null;
  fs.renameSync(file, target);
  return path.basename(target);
}

/** Values per key id per column, over every signer row. */
async function census(db, fieldEncryption) {
  const counts = {};
  let lastId = 0;
  for (;;) {
    const rows = await db('contract_signers').where('id', '>', lastId).orderBy('id', 'asc').limit(BATCH)
      .select('id', ...COLUMNS);
    if (!rows.length) break;
    for (const row of rows) {
      for (const column of COLUMNS) {
        if (!row[column]) continue;
        const keyId = fieldEncryption.keyIdOf(row[column]) || 'unreadable';
        counts[keyId] = counts[keyId] || {};
        counts[keyId][column] = (counts[keyId][column] || 0) + 1;
      }
    }
    lastId = rows[rows.length - 1].id;
  }
  return counts;
}

/**
 * Re-encrypt every value that isn't under the current key. Returns
 * `{ currentKeyId, renamedKeyFile, rewritten, skippedConcurrent, unreadable, remaining }`
 * — `remaining` counts values still under another key afterwards.
 */
async function rotate({ db, fieldEncryption, dryRun = false, log = () => {} }) {
  const renamedKeyFile = dryRun ? null : keepReplacedKeyFile(fieldEncryption);
  if (renamedKeyFile) log(`Kept the replaced key file as ${renamedKeyFile}.`);
  const currentKeyId = fieldEncryption.keyInfo().keyId;
  log(`Current key id: ${currentKeyId}. Keys that can be read: ${fieldEncryption.ringKeyIds().join(', ')}.`);

  const before = await census(db, fieldEncryption);
  for (const [keyId, columns] of Object.entries(before)) {
    const label = keyId === currentKeyId ? `${keyId} (current)` : keyId;
    log(`  ${label}: ${COLUMNS.filter((c) => columns[c]).map((c) => `${c}=${columns[c]}`).join(', ')}`);
  }
  const result = { currentKeyId, renamedKeyFile, rewritten: 0, skippedConcurrent: 0, unreadable: 0, remaining: 0 };
  if (dryRun) {
    result.remaining = Object.entries(before).filter(([id]) => id !== currentKeyId)
      .reduce((sum, [, columns]) => sum + Object.values(columns).reduce((a, b) => a + b, 0), 0);
    return result;
  }

  let lastId = 0;
  for (;;) {
    const rows = await db('contract_signers').where('id', '>', lastId).orderBy('id', 'asc').limit(BATCH)
      .select('id', ...COLUMNS);
    if (!rows.length) break;
    for (const row of rows) {
      for (const column of COLUMNS) {
        const value = row[column];
        if (!value || fieldEncryption.keyIdOf(value) === currentKeyId) continue;
        let plain;
        try {
          plain = fieldEncryption.decrypt(value);
        } catch (_) {
          result.unreadable += 1;
          continue;
        }
        const updated = await db('contract_signers')
          .where({ id: row.id, [column]: value })
          .update({ [column]: fieldEncryption.encrypt(plain) });
        if (updated) result.rewritten += 1;
        else result.skippedConcurrent += 1;
      }
    }
    lastId = rows[rows.length - 1].id;
    log(`  … up to signer ${lastId}: ${result.rewritten} re-encrypted`);
  }

  const after = await census(db, fieldEncryption);
  result.remaining = Object.entries(after).filter(([id]) => id !== currentKeyId)
    .reduce((sum, [, columns]) => sum + Object.values(columns).reduce((a, b) => a + b, 0), 0);
  return result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { db } = require('../src/database/db');
  const fieldEncryption = require('../src/utils/fieldEncryption');
  console.log('\n========================================');
  console.log('PicPeak evidence key rotation');
  console.log('========================================\n');
  try {
    const problem = fieldEncryption.keyProblemAtBoot();
    if (problem) throw new Error(problem);
    const result = await rotate({ db, fieldEncryption, dryRun, log: (line) => console.log(line) });
    console.log('');
    if (dryRun) {
      console.log(`Dry run: ${result.remaining} value(s) would be re-encrypted under ${result.currentKeyId}.`);
    } else {
      console.log(`Re-encrypted: ${result.rewritten}. Changed while running (left for the next run): ${result.skippedConcurrent}.`);
      console.log(`Unreadable (their key is not available): ${result.unreadable}.`);
      console.log(`Values still under another key: ${result.remaining}.`);
      console.log(result.remaining === 0
        ? 'Done. The old keys are no longer needed for signing evidence.'
        : 'Not done: keep the old keys, make any missing one readable, and run this again.');
    }
    await db.destroy();
    process.exit(!dryRun && result.remaining > 0 ? 2 : 0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    try { await db.destroy(); } catch (_) { /* already closed */ }
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { rotate, census, COLUMNS };
