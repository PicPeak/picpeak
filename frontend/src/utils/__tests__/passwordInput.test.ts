import { describe, expect, it } from 'vitest';
import { sanitizePasswordInput } from '../passwordInput';

/**
 * Tests for the gallery-password sanitizer (#654). Passwords copy-pasted out
 * of Instagram DMs/bios carry invisible Unicode that fails the backend's
 * byte-exact bcrypt compare; the sanitizer must strip exactly those while
 * leaving every visible character untouched.
 */

describe('sanitizePasswordInput', () => {
  it('leaves a normal password unchanged', () => {
    expect(sanitizePasswordInput('wedding2026')).toBe('wedding2026');
  });

  it('trims leading and trailing whitespace (predictive-keyboard trailing space)', () => {
    expect(sanitizePasswordInput('  wedding2026 ')).toBe('wedding2026');
  });

  it('strips a mid-string zero-width space (U+200B)', () => {
    expect(sanitizePasswordInput('wedding\u200B2026')).toBe('wedding2026');
  });

  it('strips zero-width non-joiner and joiner (U+200C, U+200D)', () => {
    expect(sanitizePasswordInput('wed\u200Cding\u200D2026')).toBe('wedding2026');
  });

  it('strips word joiner and BOM (U+2060, U+FEFF)', () => {
    expect(sanitizePasswordInput('\uFEFFwedding\u20602026')).toBe('wedding2026');
  });

  it('strips soft hyphens (U+00AD)', () => {
    expect(sanitizePasswordInput('wedding\u00AD2026')).toBe('wedding2026');
  });

  it('does not touch visible special characters', () => {
    expect(sanitizePasswordInput('wédd-ing_20%26!')).toBe('wédd-ing_20%26!');
  });

  it('preserves interior regular spaces (only edges are trimmed)', () => {
    expect(sanitizePasswordInput(' my secret pass ')).toBe('my secret pass');
  });

  it('returns empty string for whitespace/invisible-only input', () => {
    expect(sanitizePasswordInput(' \u200B\uFEFF ')).toBe('');
  });
});
