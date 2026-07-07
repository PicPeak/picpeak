#!/usr/bin/env node

/**
 * Script to set/reset admin password
 *
 * Usage:
 *   node set-admin-password.js <new-password>
 *   node set-admin-password.js --env  (uses ADMIN_PASSWORD environment variable)
 *
 * Security: Password must be at least 8 characters with mixed case, numbers, and special characters
 */

const bcrypt = require('bcrypt');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const knex = require('knex');
const db = knex({
  client: process.env.DB_CLIENT || 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'picpeak',
    password: process.env.DB_PASSWORD || 'picpeak',
    database: process.env.DB_NAME || 'picpeak_dev'
  }
});

/**
 * Validate password strength
 */
function validatePassword(password) {
  if (!password || password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' };
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one special character' };
  }
  return { valid: true };
}

function printUsage() {
  console.log(`
Usage:
  node set-admin-password.js <new-password>
  node set-admin-password.js --env

Options:
  <new-password>  The new password to set (must meet security requirements)
  --env           Use ADMIN_PASSWORD environment variable

Security Requirements:
  - At least 8 characters
  - At least one lowercase letter
  - At least one uppercase letter
  - At least one number
  - At least one special character (!@#$%^&*()_+-=[]{}|;':\",./<>?)

Examples:
  node set-admin-password.js "MySecure@Pass123"
  ADMIN_PASSWORD="MySecure@Pass123" node set-admin-password.js --env
`);
}

async function setAdminPassword() {
  try {
    // Get password from argument or environment
    const args = process.argv.slice(2);
    let password;

    if (args.length === 0) {
      console.error('❌ Error: No password provided\n');
      printUsage();
      process.exit(1);
    }

    if (args[0] === '--env') {
      password = process.env.ADMIN_PASSWORD;
      if (!password) {
        console.error('❌ Error: ADMIN_PASSWORD environment variable not set');
        process.exit(1);
      }
    } else if (args[0] === '--help' || args[0] === '-h') {
      printUsage();
      process.exit(0);
    } else {
      password = args[0];
    }

    // Validate password strength
    const validation = validatePassword(password);
    if (!validation.valid) {
      console.error(`❌ Error: ${validation.error}`);
      process.exit(1);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Update database
    const updated = await db('admin_users')
      .where('username', 'admin')
      .update({
        password_hash: hashedPassword,
        password_changed_at: new Date(),
        updated_at: new Date()
      });

    if (updated === 0) {
      console.error('❌ Error: Admin user not found');
      process.exit(1);
    }

    console.log('✅ Admin password updated successfully');
    console.log('   Note: All existing sessions have been invalidated');

    await db.destroy();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error setting password:', error.message);
    await db.destroy();
    process.exit(1);
  }
}

setAdminPassword();
