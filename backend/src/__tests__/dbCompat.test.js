const { formatBoolean, isPostgreSQL, addDays, formatDateForDB, insertAndGetId } = require('../utils/dbCompat');

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

  describe('formatDateForDB', () => {
    test('should format dates as ISO strings', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      expect(formatDateForDB(date)).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('addDays', () => {
    test('should add days correctly', () => {
      const date = new Date('2024-01-15');
      const result = addDays(date, 30);
      expect(result.toISOString().split('T')[0]).toBe('2024-02-14');
      
      const negativeResult = addDays(date, -7);
      expect(negativeResult.toISOString().split('T')[0]).toBe('2024-01-08');
    });
  });

  describe('insertAndGetId', () => {
    test('should handle PostgreSQL result format', async () => {
      const mockQuery = {
        returning: jest.fn().mockResolvedValue([{ id: 123 }])
      };
      const result = await insertAndGetId(mockQuery);
      expect(result).toBe(123);
    });

    test('should handle SQLite result format', async () => {
      const mockQuery = {
        returning: jest.fn().mockResolvedValue([456])
      };
      const result = await insertAndGetId(mockQuery);
      expect(result).toBe(456);
    });
  });
});