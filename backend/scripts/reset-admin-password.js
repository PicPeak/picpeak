#!/usr/bin/env node

const bcrypt = require('bcrypt');
const { db } = require('../src/database/db');
const { generateReadablePassword } = require('../src/utils/passwordGenerator');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const getOption = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return null;
};

const force = hasFlag('--force') || hasFlag('--yes') || hasFlag('--non-interactive');
const credentialsFileArg = getOption('credentials-file');
const resolvedCredentialsFile = credentialsFileArg
  ? path.resolve(process.cwd(), credentialsFileArg)
  : path.join(__dirname, '..', '..', 'ADMIN_PASSWORD_RESET.txt');

const rl = force ? null : readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function ask(prompt) {
  if (force) {
    return 'yes';
  }

  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function resetAdminPassword() {
  console.log('\n========================================');
  console.log('PicPeak Admin Password Reset Tool');
  console.log('========================================\n');

  try {
    // Check if admin user exists
    const admin = await db('admin_users')
      .where({ username: 'admin' })
      .first();

    if (!admin) {
      console.error('❌ No admin user found in the database.');
      console.log('Run migrations first: npm run migrate');
      process.exit(1);
    }

    console.log('Found admin user:', admin.username);
    console.log('Email:', admin.email);
    if (!force) {
      console.log('\nThis will reset the password for this admin account.');
    }

    const confirm = await ask('\nDo you want to continue? (yes/no): ');

    if (!force) {
      const normalized = confirm.trim().toLowerCase();
      if (normalized !== 'yes' && normalized !== 'y') {
        console.log('\n❌ Password reset cancelled.');
        process.exit(0);
      }
    }

    // Generate new password
    const newPassword = generateReadablePassword();
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update the admin user
    await db('admin_users')
      .where({ username: 'admin' })
      .update({
        password_hash: passwordHash,
        must_change_password: true,
        updated_at: new Date()
      });

    // Save to file
    const credentialsDir = path.dirname(resolvedCredentialsFile);
    await fs.mkdir(credentialsDir, { recursive: true });

    const adminUrl = `${process.env.ADMIN_URL || 'http://localhost:3001'}/admin`;
    const resetInfo = `
========================================
PicPeak Admin Credentials
========================================

Your admin account has been reset with these credentials:

Username: ${admin.username}
Email: ${admin.email}
Password: ${newPassword}

IMPORTANT SECURITY NOTES:
1. You MUST change this password after first login
2. This file contains sensitive information
3. Delete this file after noting the password

Login URL: ${adminUrl}

Reset performed on: ${new Date().toISOString()}
========================================
`;

    await fs.writeFile(resolvedCredentialsFile, resetInfo, 'utf8');

    console.log('\n✅ Password reset successful!\n');
    console.log('========================================');
    console.log('New Credentials:');
    console.log('========================================');
    console.log(`Username: ${admin.username}`);
    console.log(`Email: ${admin.email}`);
    console.log(`Password: ${newPassword}`);
    console.log('\n⚠️  IMPORTANT:');
    console.log('1. You will be required to change this password on next login');
    console.log(`2. Credentials are also saved in: ${resolvedCredentialsFile}`);
    console.log('3. Delete the file after noting the password');
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Error resetting password:', error.message);
    process.exit(1);
  } finally {
    if (rl) {
      rl.close();
    }
    process.exit(0);
  }
}

// Run the reset
resetAdminPassword();
