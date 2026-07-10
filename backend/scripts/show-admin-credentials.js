#!/usr/bin/env node

/**
 * Show or reset admin credentials
 */

const bcrypt = require('bcrypt');
const { db } = require('../src/database/db');
const { generateReadablePassword } = require('../src/utils/passwordGenerator');

async function showAdminCredentials(resetPassword = false) {
  try {
    // Get admin user
    const admin = await db('admin_users')
      .where('username', 'admin')
      .first();
    
    if (!admin) {
      console.error('❌ No admin user found in database');
      process.exit(1);
    }
    
    console.log('\n========================================');
    console.log('PicPeak Admin Credentials');
    console.log('========================================');
    console.log(`Username: ${admin.username}`);
    console.log(`Email: ${admin.email}`);
    
    if (resetPassword) {
      // Generate new password
      const newPassword = generateReadablePassword();
      const passwordHash = await bcrypt.hash(newPassword, 12);
      
      // Update password
      await db('admin_users')
        .where('id', admin.id)
        .update({
          password_hash: passwordHash,
          must_change_password: true,
          updated_at: new Date()
        });

      console.log(`Password: ${newPassword}`);
      console.log('\n⚠️  IMPORTANT:');
      console.log('1. Save this password securely - it will not be shown again');
      console.log('2. You will be required to change it on next login');
    } else {
      console.log('Password: [hidden - use --reset flag to generate new password]');
    }
    
    console.log('\nLogin URL: http://localhost:3001/admin');
    console.log('========================================\n');
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Check for reset flag
const resetPassword = process.argv.includes('--reset');

if (resetPassword) {
  console.log('🔄 Resetting admin password...');
}

showAdminCredentials(resetPassword);