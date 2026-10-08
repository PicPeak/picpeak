'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { generateSecurePassword } = require('../utils/passwordGenerator');
const { getBcryptRounds } = require('../utils/passwordValidation');
const {
  parseEmailData,
  redactEmailData,
  redactRenderedHtml,
  redactRecoveryLinks,
  redactRecoveryLinksInData,
  secretValues,
} = require('../utils/emailSecretRedaction');
const {
  decryptEmailData,
  encryptEmailData,
  isEncryptedEmailData,
  isProtectedEmailType,
  PROTECTED_PENDING_STATUS,
} = require('../utils/emailQueueEncryption');

const TOKEN_TABLES = [
  ['admin_invitations', 'accepted_at'],
  ['customer_invitations', 'accepted_at'],
  ['customer_password_resets', 'used_at'],
];
const LINK_EMAIL_TYPES = new Set(['admin_invitation', 'customer_invitation', 'customer_password_reset']);
const TOKEN_GUARD_TABLES = TOKEN_TABLES.map(([tableName]) => tableName);
const EMAIL_GUARD_NAME = 'picpeak_recovery_email_queue_guard';

function digest(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

async function ensureAccountRecoveryDigestColumns(knex) {
  for (const [tableName] of TOKEN_TABLES) {
    if (!(await knex.schema.hasTable(tableName))) continue;
    if (!(await knex.schema.hasColumn(tableName, 'token_digest'))) {
      await knex.schema.alterTable(tableName, (table) => {
        table.string('token_digest', 64).index();
      });
    }
  }
}

// Returns how many outstanding (unconsumed) rows were expired.
async function hardenTokenTable(knex, tableName, consumedColumn) {
  if (!(await knex.schema.hasTable(tableName))
    || !(await knex.schema.hasColumn(tableName, 'token_digest'))) return 0;
  const rows = await knex(tableName)
    .whereNull('token_digest')
    .select('id', 'token', consumedColumn);
  // Bind a Date, not ISO text. SQLite stores service-created expiries as
  // epoch integers and compares by storage class; TEXT > INTEGER is always
  // true there, which would leave a supposedly expired legacy token usable.
  const expiredAt = new Date(Date.now() - 1000);
  let expired = 0;
  for (const row of rows) {
    const tokenDigest = digest(row.token);
    const outstanding = row[consumedColumn] == null;
    const updated = await knex(tableName).where({ id: row.id }).whereNull('token_digest').update({
      token: tokenDigest,
      token_digest: tokenDigest,
      ...(outstanding ? { expires_at: expiredAt } : {}),
    });
    if (outstanding && updated) expired += 1;
  }
  return expired;
}

async function bcryptMatches(password, hash) {
  if (typeof password !== 'string' || !hash) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch (_) {
    return false;
  }
}

async function adminForReset(knex, row, data, leakedPassword) {
  const candidates = [];
  const remember = (admin) => {
    if (admin && !candidates.some((candidate) => candidate.id === admin.id)) candidates.push(admin);
  };
  if (row.recipient_email) {
    remember(await knex('admin_users')
      .whereRaw('LOWER(email) = LOWER(?)', [String(row.recipient_email)])
      .first());
  }
  if (data && typeof data.username === 'string' && data.username.trim()) {
    remember(await knex('admin_users').where({ username: data.username.trim() }).first());
  }
  for (const candidate of candidates) {
    if (await bcryptMatches(leakedPassword, candidate.password_hash)) return candidate;
  }

  // Email and username are editable. If both changed after the reset, find the
  // unique local account whose current hash still matches the leaked queued
  // password. Generated reset passwords should have exactly one match.
  const admins = await knex('admin_users').whereNotNull('password_hash').select('*');
  const matches = [];
  for (const admin of admins) {
    if (candidates.some((candidate) => candidate.id === admin.id)) continue;
    if (await bcryptMatches(leakedPassword, admin.password_hash)) matches.push(admin);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function rotateLegacyAdminReset(knex, row, data, hasRenderedHtml) {
  const leakedPassword = data && data.new_password;
  const admin = await adminForReset(knex, row, data, leakedPassword);
  if (!admin) return null;

  const newPassword = generateSecurePassword(16);
  const passwordHash = await bcrypt.hash(newPassword, getBcryptRounds());
  const now = new Date();
  // Do not overwrite a password changed while the comparison/hash ran.
  const changed = await knex('admin_users')
    .where({ id: admin.id, password_hash: admin.password_hash })
    .update({
      password_hash: passwordHash,
      must_change_password: knex.client.config.client === 'pg' ? true : 1,
      password_changed_at: now,
      updated_at: now,
    });
  if (changed !== 1) return null;

  if (await knex.schema.hasTable('api_tokens')) {
    await knex('api_tokens').where({ created_by: admin.id }).whereNull('revoked_at')
      .update({ revoked_at: now });
  }
  // The queued address may have changed since this temporary password was
  // issued. Bind and deliver the replacement only to the account's current
  // address, including when the account was found by its password hash.
  const recipientEmail = admin.email || row.recipient_email;
  const update = {
    email_data: JSON.stringify(encryptEmailData(
      row.email_type,
      { ...data, username: admin.username, new_password: newPassword },
      recipientEmail,
    )),
    recipient_email: recipientEmail,
    status: PROTECTED_PENDING_STATUS,
    retry_count: 0,
    scheduled_at: null,
    sent_at: null,
    error_message: null,
  };
  if (hasRenderedHtml) update.rendered_html = null;
  const queueUpdated = await knex('email_queue')
    .where({ id: row.id, status: row.status })
    .update(update);
  if (queueUpdated !== 1) throw new Error('Pending admin reset changed during credential rotation');
  return { id: admin.id, username: admin.username, email: recipientEmail };
}

async function hardenQueueRows(knex) {
  if (!(await knex.schema.hasTable('email_queue'))) return;
  const hasRenderedHtml = await knex.schema.hasColumn('email_queue', 'rendered_html');
  const columns = ['id', 'recipient_email', 'email_type', 'email_data', 'status'];
  if (hasRenderedHtml) columns.push('rendered_html');
  const rows = await knex('email_queue').select(columns);

  for (const row of rows) {
    let data = parseEmailData(row.email_data);
    const protectedType = isProtectedEmailType(row.email_type);
    // Rows written by the fixed queue are already protected. Still erase any
    // legacy rendered body left by a partially completed upgrade/import and
    // move old "pending" envelopes outside the old worker's pickup protocol.
    if (protectedType && isEncryptedEmailData(data)) {
      try {
        // Shape alone is not proof of encryption: workflow input or an
        // archive can forge a marker with valid-looking base64url segments.
        // Authenticate every envelope before preserving it.
        decryptEmailData(row.email_type, data, row.recipient_email);
      } catch (_) {
        const update = {
          email_data: '{}',
          status: 'failed',
          error_message: 'This account-recovery email failed authenticated storage validation. Create a new invitation or password reset.',
        };
        if (hasRenderedHtml) update.rendered_html = null;
        await knex('email_queue').where({ id: row.id }).update(update);
        continue;
      }
      const update = {};
      if (protectedType && hasRenderedHtml && row.rendered_html) update.rendered_html = null;
      if (protectedType && row.status === 'pending') update.status = PROTECTED_PENDING_STATUS;
      if (Object.keys(update).length) await knex('email_queue').where({ id: row.id }).update(update);
      continue;
    }

    const before = JSON.stringify(data);
    const recoveryRedacted = redactRecoveryLinksInData(data);
    const containsRecoveryLink = JSON.stringify(recoveryRedacted) !== before;
    if (!protectedType && !containsRecoveryLink) continue;

    // A row that reached a final state keeps only the archive mask (or
    // nothing) in place of the temporary password. There is no credential to
    // compare then, so it is scrubbed below without any bcrypt work.
    if (row.email_type === 'admin_password_reset'
      && secretValues({ new_password: data && data.new_password }).length) {
      // The SQLite migration runner is not transactional. Give every
      // password/hash + API-token + queue replacement its own transaction
      // (a savepoint when the caller is already the import transaction).
      const rotated = await knex.transaction(
        (trx) => rotateLegacyAdminReset(trx, row, data, hasRenderedHtml),
      );
      if (rotated) {
        // The stored plaintext was still this account's live password, so the
        // account itself changed. Say whose, never the password.
        console.warn('Account recovery hardening: the password of admin '
          + `${JSON.stringify(rotated.username)} (id ${rotated.id}, ${rotated.email}) was reset by the `
          + `security upgrade because email_queue row ${row.id} (${row.status}) stored it in plaintext. `
          + 'A new password-reset email was queued to that address.');
        continue;
      }
    }
    if (row.email_type === 'admin_password_reset' && row.status === 'pending') {
      const update = {
        email_data: JSON.stringify(redactEmailData(data)),
        status: 'failed',
        error_message: 'This queued temporary password is no longer current. Reset the administrator password again.',
      };
      if (hasRenderedHtml) update.rendered_html = null;
      await knex('email_queue').where({ id: row.id, status: 'pending' }).update(update);
      continue;
    }

    const secrets = secretValues(data);
    data = redactRecoveryLinksInData(redactEmailData(data));
    const update = { email_data: JSON.stringify(data) };
    if (hasRenderedHtml && row.rendered_html) {
      update.rendered_html = redactRecoveryLinks(redactRenderedHtml(row.rendered_html, secrets));
    }
    if (row.status === 'pending' && (LINK_EMAIL_TYPES.has(row.email_type) || containsRecoveryLink)) {
      update.status = 'failed';
      update.error_message = 'This invitation or password-reset link was expired by a security upgrade. Send a new one.';
    }
    await knex('email_queue').where({ id: row.id }).update(update);
  }
}

async function hardenAccountRecoveryStorage(knex) {
  for (const [tableName, consumedColumn] of TOKEN_TABLES) {
    const expired = await hardenTokenTable(knex, tableName, consumedColumn);
    if (expired > 0) {
      console.log(`Account recovery hardening: expired ${expired} outstanding ${tableName} row(s); `
        + 'send those invitations or password resets again.');
    }
  }
  await hardenQueueRows(knex);
}

async function removeAccountRecoveryWriteGuards(knex) {
  const isPg = knex.client.config.client === 'pg';
  if (isPg) {
    for (const tableName of TOKEN_GUARD_TABLES) {
      if (await knex.schema.hasTable(tableName)) {
        await knex.raw(`DROP TRIGGER IF EXISTS picpeak_recovery_${tableName}_guard ON ${tableName}`);
      }
    }
    if (await knex.schema.hasTable('email_queue')) {
      await knex.raw(`DROP TRIGGER IF EXISTS ${EMAIL_GUARD_NAME} ON email_queue`);
    }
    await knex.raw('DROP FUNCTION IF EXISTS picpeak_recovery_token_guard()');
    await knex.raw('DROP FUNCTION IF EXISTS picpeak_recovery_email_guard()');
    return;
  }
  for (const tableName of TOKEN_GUARD_TABLES) {
    await knex.raw(`DROP TRIGGER IF EXISTS picpeak_recovery_${tableName}_insert_guard`);
    await knex.raw(`DROP TRIGGER IF EXISTS picpeak_recovery_${tableName}_update_guard`);
  }
  await knex.raw(`DROP TRIGGER IF EXISTS ${EMAIL_GUARD_NAME}_insert`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${EMAIL_GUARD_NAME}_update`);
}

async function installAccountRecoveryWriteGuards(knex) {
  await removeAccountRecoveryWriteGuards(knex);
  const tokenTables = [];
  for (const tableName of TOKEN_GUARD_TABLES) {
    if (await knex.schema.hasTable(tableName)
      && await knex.schema.hasColumn(tableName, 'token_digest')) tokenTables.push(tableName);
  }
  const hasEmailQueue = await knex.schema.hasTable('email_queue');
  const isPg = knex.client.config.client === 'pg';
  if (isPg) {
    if (tokenTables.length) {
      await knex.raw(`
        CREATE FUNCTION picpeak_recovery_token_guard() RETURNS trigger AS $$
        BEGIN
          IF NEW.token_digest IS NULL THEN
            RAISE EXCEPTION 'account-recovery token_digest is required';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
    }
    for (const tableName of tokenTables) {
      await knex.raw(`
        CREATE TRIGGER picpeak_recovery_${tableName}_guard
        BEFORE INSERT OR UPDATE ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION picpeak_recovery_token_guard()
      `);
    }
    if (hasEmailQueue) await knex.raw(`
      CREATE FUNCTION picpeak_recovery_email_guard() RETURNS trigger AS $$
      BEGIN
        IF NEW.email_type IN ('admin_invitation', 'admin_password_reset', 'customer_invitation', 'customer_password_reset')
           AND NEW.status IN ('pending', '${PROTECTED_PENDING_STATUS}')
           AND (NEW.status <> '${PROTECTED_PENDING_STATUS}'
                OR CASE WHEN jsonb_typeof(NEW.email_data::jsonb) = 'object' THEN
                  NEW.email_data::jsonb <> jsonb_build_object(
                    '__picpeak_encrypted_email_v1',
                    NEW.email_data::jsonb -> '__picpeak_encrypted_email_v1'
                  )
                  OR jsonb_typeof(NEW.email_data::jsonb -> '__picpeak_encrypted_email_v1') IS DISTINCT FROM 'string'
                  OR (NEW.email_data::jsonb ->> '__picpeak_encrypted_email_v1')
                     !~ '^[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]+$'
                ELSE TRUE END) THEN
          RAISE EXCEPTION 'pending account-recovery email must use protected storage';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    if (hasEmailQueue) await knex.raw(`
      CREATE TRIGGER ${EMAIL_GUARD_NAME}
      BEFORE INSERT OR UPDATE ON email_queue
      FOR EACH ROW EXECUTE FUNCTION picpeak_recovery_email_guard()
    `);
    return;
  }

  for (const tableName of tokenTables) {
    await knex.raw(`
      CREATE TRIGGER picpeak_recovery_${tableName}_insert_guard
      BEFORE INSERT ON ${tableName}
      WHEN NEW.token_digest IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'account-recovery token_digest is required');
      END
    `);
    await knex.raw(`
      CREATE TRIGGER picpeak_recovery_${tableName}_update_guard
      BEFORE UPDATE ON ${tableName}
      WHEN NEW.token_digest IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'account-recovery token_digest is required');
      END
    `);
  }
  const sqliteGuard = `
    WHEN NEW.email_type IN ('admin_invitation', 'admin_password_reset', 'customer_invitation', 'customer_password_reset')
      AND NEW.status IN ('pending', '${PROTECTED_PENDING_STATUS}')
      AND (NEW.status <> '${PROTECTED_PENDING_STATUS}' OR CASE
        WHEN json_valid(COALESCE(CAST(NEW.email_data AS TEXT), '')) = 1 THEN
          json_type(NEW.email_data, '$.__picpeak_encrypted_email_v1') IS NOT 'text'
          OR (SELECT COUNT(*) FROM json_each(NEW.email_data)) <> 1
          OR LENGTH(json_extract(NEW.email_data, '$.__picpeak_encrypted_email_v1')) < 41
          OR SUBSTR(json_extract(NEW.email_data, '$.__picpeak_encrypted_email_v1'), 17, 1) <> '.'
          OR SUBSTR(json_extract(NEW.email_data, '$.__picpeak_encrypted_email_v1'), 40, 1) <> '.'
          OR INSTR(SUBSTR(json_extract(NEW.email_data, '$.__picpeak_encrypted_email_v1'), 41), '.') <> 0
          OR REPLACE(json_extract(NEW.email_data, '$.__picpeak_encrypted_email_v1'), '.', '') GLOB '*[^A-Za-z0-9_-]*'
        ELSE 1
      END)
    BEGIN
      SELECT RAISE(ABORT, 'pending account-recovery email must use protected storage');
    END
  `;
  if (hasEmailQueue) {
    await knex.raw(`
      CREATE TRIGGER ${EMAIL_GUARD_NAME}_insert
      BEFORE INSERT ON email_queue
      ${sqliteGuard}
    `);
    await knex.raw(`
      CREATE TRIGGER ${EMAIL_GUARD_NAME}_update
      BEFORE UPDATE ON email_queue
      ${sqliteGuard}
    `);
  }
}

module.exports = {
  ensureAccountRecoveryDigestColumns,
  hardenAccountRecoveryStorage,
  installAccountRecoveryWriteGuards,
  removeAccountRecoveryWriteGuards,
};
