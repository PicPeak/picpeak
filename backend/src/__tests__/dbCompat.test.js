const { formatBoolean, isPostgreSQL } = require('../utils/dbCompat');

describe('Database Compatibility', () => {
  // Save original env
  const originalEnv = process.env.DATABASE_CLIENT;
  
  afterEach(() => {
    // Restore original env after each test
    if (originalEnv) {
      process.env.DATABASE_CLIENT = originalEnv;
    } else {
      delete process.env.DATABASE_CLIENT;
    }
  });

  describe('formatBoolean', () => {
    test('should format boolean values correctly', () => {
      // Mock for SQLite
      process.env.DATABASE_CLIENT = 'sqlite3';
      expect(formatBoolean(true)).toBe(1);
      expect(formatBoolean(false)).toBe(0);
      
      // Mock for PostgreSQL
      process.env.DATABASE_CLIENT = 'pg';
      expect(formatBoolean(true)).toBe(true);
      expect(formatBoolean(false)).toBe(false);
      
      // Default (no env var) should be SQLite
      delete process.env.DATABASE_CLIENT;
      expect(formatBoolean(true)).toBe(1);
      expect(formatBoolean(false)).toBe(0);
    });
  });

  describe('isPostgreSQL', () => {
    test('should detect PostgreSQL correctly', () => {
      process.env.DATABASE_CLIENT = 'pg';
      expect(isPostgreSQL()).toBe(true);
      
      process.env.DATABASE_CLIENT = 'sqlite3';
      expect(isPostgreSQL()).toBe(false);
      
      delete process.env.DATABASE_CLIENT;
      expect(isPostgreSQL()).toBe(false); // Default to SQLite
    });
  });
});