const crypto = require('crypto');

/**
 * Generate a secure random password
 * @param {number} length - Password length (default: 16)
 * @returns {string} Generated password
 */
function generateSecurePassword(length = 16) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  let password = '';
  
  // Ensure at least one of each required character type
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  
  // Add one of each required type
  password += lowercase[crypto.randomInt(lowercase.length)];
  password += uppercase[crypto.randomInt(uppercase.length)];
  password += numbers[crypto.randomInt(numbers.length)];
  password += special[crypto.randomInt(special.length)];
  
  // Fill the rest randomly
  for (let i = password.length; i < length; i++) {
    password += charset[crypto.randomInt(charset.length)];
  }
  
  // Shuffle the password
  return password.split('').sort(() => crypto.randomInt(3) - 1).join('');
}

/**
 * Generate a human-readable password using words and numbers
 * @returns {string} Generated password
 */
function generateReadablePassword() {
  const adjectives = [
    'Swift', 'Bright', 'Strong', 'Happy', 'Clever',
    'Brave', 'Noble', 'Quick', 'Sharp', 'Bold'
  ];
  
  const nouns = [
    'Eagle', 'Mountain', 'River', 'Thunder', 'Forest',
    'Ocean', 'Falcon', 'Dragon', 'Phoenix', 'Tiger'
  ];
  
  const adjective = adjectives[crypto.randomInt(adjectives.length)];
  const noun = nouns[crypto.randomInt(nouns.length)];
  const number = crypto.randomInt(1000, 9999);
  const special = '!@#$%'[crypto.randomInt(5)];
  
  return `${adjective}${noun}${number}${special}`;
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {object} Validation result with score and messages
 */
function validatePasswordStrength(password) {
  const result = {
    score: 0,
    messages: [],
    isValid: false
  };
  
  // Length check
  if (password.length < 8) {
    result.messages.push('Password must be at least 8 characters long');
  } else if (password.length < 12) {
    result.score += 1;
  } else {
    result.score += 2;
  }
  
  // Character type checks
  if (!/[a-z]/.test(password)) {
    result.messages.push('Password must contain lowercase letters');
  } else {
    result.score += 1;
  }
  
  if (!/[A-Z]/.test(password)) {
    result.messages.push('Password must contain uppercase letters');
  } else {
    result.score += 1;
  }
  
  if (!/[0-9]/.test(password)) {
    result.messages.push('Password must contain numbers');
  } else {
    result.score += 1;
  }
  
  if (!/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password)) {
    result.messages.push('Password must contain special characters');
  } else {
    result.score += 1;
  }
  
  // Common password check
  const commonPasswords = [
    'password', 'admin123', '12345678', 'qwerty', 'abc123',
    'password123', 'admin', 'letmein', 'welcome', 'monkey'
  ];
  
  if (commonPasswords.includes(password.toLowerCase())) {
    result.score = 0;
    result.messages.push('Password is too common');
  }
  
  result.isValid = result.score >= 4 && result.messages.length === 0;
  
  return result;
}

module.exports = {
  generateSecurePassword,
  generateReadablePassword,
  validatePasswordStrength
};