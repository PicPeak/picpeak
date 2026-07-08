#!/usr/bin/env node
/**
 * reset-admin-mfa.js — disable two-factor auth for a locked-out admin (#738).
 *
 * Break-glass recovery for when an admin loses their authenticator AND their
 * recovery codes. Clears the MFA state so the admin can log in with just their
 * password and re-enroll from Settings.
 *
 * Usage (inside the running backend container):
 *   docker compose exec backend node scripts/reset-admin-mfa.js --email admin@example.com
 *   docker compose exec backend node scripts/reset-admin-mfa.js --all --yes
 *
 * Flags:
 *   --email <addr>   target a single admin by email (or --username <name>)
 *   --all            reset MFA for EVERY admin (full lockout / break-glass)
 *   --yes            non-interactive (skip the confirmation prompt)
 */

const readline = require('readline');
const { db, logActivity } = require('../src/database/db');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOption = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
};

const force = hasFlag('--yes') || hasFlag('--force') || hasFlag('--non-interactive');
const all = hasFlag('--all');
const email = getOption('email');
const username = getOption('username');

const MFA_CLEAR = {
  two_factor_enabled: false,
  two_factor_secret: null,
  two_factor_recovery_codes: null,
  two_factor_enrolled_at: null,
  updated_at: new Date(),
};

function ask(prompt) {
  if (force) return Promise.resolve('yes');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a); }));
}

async function main() {
  console.log('\n========================================');
  console.log('PicPeak Admin MFA Reset Tool');
  console.log('========================================\n');

  if (!all && !email && !username) {
    console.error('❌ Specify a target: --email <addr>, --username <name>, or --all');
    console.log('   e.g. node scripts/reset-admin-mfa.js --email admin@example.com');
    process.exit(1);
  }

  // Resolve target admins.
  let targets;
  if (all) {
    targets = await db('admin_users').select('id', 'username', 'email', 'two_factor_enabled');
  } else {
    const q = db('admin_users');
    if (email) q.where({ email });
    if (username) q.where({ username });
    targets = await q.select('id', 'username', 'email', 'two_factor_enabled');
  }

  if (targets.length === 0) {
    console.error('❌ No matching admin user found.');
    process.exit(1);
  }

  const enrolled = targets.filter((t) => t.two_factor_enabled === true || t.two_factor_enabled === 1);
  console.log(`Matched ${targets.length} admin(s); ${enrolled.length} currently have MFA enabled:`);
  for (const t of targets) {
    const flag = (t.two_factor_enabled === true || t.two_factor_enabled === 1) ? 'MFA ON' : 'mfa off';
    console.log(`  - ${t.username} <${t.email}>  [${flag}]`);
  }

  const confirm = await ask('\nDisable MFA for the above? (yes/no): ');
  const normalized = String(confirm).trim().toLowerCase();
  if (normalized !== 'yes' && normalized !== 'y') {
    console.log('\n❌ Cancelled. No changes made.');
    process.exit(0);
  }

  const ids = targets.map((t) => t.id);
  const updated = await db('admin_users').whereIn('id', ids).update(MFA_CLEAR);

  for (const t of targets) {
    try {
      await logActivity('admin_mfa_reset_cli',
        { admin_id: t.id, via: 'cli' },
        null,
        { type: 'system', id: 0, name: 'reset-admin-mfa.js' }
      );
    } catch (_) { /* activity log is best-effort */ }
  }

  console.log(`\n✅ MFA disabled for ${updated} admin(s). They can now log in with just their password and re-enroll from Settings → Security.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed to reset MFA:', err.message);
  process.exit(1);
});
