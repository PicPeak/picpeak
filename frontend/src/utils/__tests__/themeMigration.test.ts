import { describe, expect, it } from 'vitest';
import { migrateThemeConfig, applyForceColorMode } from '../themeMigration';
import type { ThemeConfig } from '../../types/theme.types';

describe('migrateThemeConfig — 8-token palette fill', () => {
  it('derives light surface defaults for a legacy 4-color light theme', () => {
    const legacy: ThemeConfig = {
      primaryColor: '#5C8762',
      accentColor: '#22c55e',
      backgroundColor: '#fafafa',
      textColor: '#171717',
      colorMode: 'light',
      galleryLayout: 'grid',
    };

    const migrated = migrateThemeConfig(legacy);

    expect(migrated.surfaceColor).toBe('#ffffff');
    expect(migrated.elevatedColor).toBe('#f5f5f5');
    expect(migrated.surfaceBorderColor).toBe('#e5e5e5');
    expect(migrated.mutedTextColor).toBe('#737373');
    // Legacy primaryColor was used as the CTA fill — preserved as accentDark.
    expect(migrated.accentDarkColor).toBe('#5C8762');
    // Existing fields untouched.
    expect(migrated.primaryColor).toBe('#5C8762');
    expect(migrated.backgroundColor).toBe('#fafafa');
    expect(migrated.textColor).toBe('#171717');
  });

  it('derives dark surface defaults for a legacy 4-color dark theme', () => {
    const legacy: ThemeConfig = {
      primaryColor: '#3b82f6',
      accentColor: '#1e40af',
      backgroundColor: '#0a0a0a',
      textColor: '#f5f5f5',
      colorMode: 'dark',
      galleryLayout: 'grid',
    };

    const migrated = migrateThemeConfig(legacy);

    expect(migrated.surfaceColor).toBe('#1a1a1a');
    expect(migrated.elevatedColor).toBe('#242424');
    expect(migrated.surfaceBorderColor).toBe('#2e2e2e');
    expect(migrated.mutedTextColor).toBe('#a3a3a3');
    expect(migrated.accentDarkColor).toBe('#3b82f6');
  });

  it('does not overwrite explicit 8-token values', () => {
    const fullPalette: ThemeConfig = {
      primaryColor: '#014E4E',
      accentColor: '#017C7C',
      accentDarkColor: '#014E4E',
      backgroundColor: '#0D0D0D',
      surfaceColor: '#111414',
      elevatedColor: '#182222',
      surfaceBorderColor: '#1E2E2E',
      textColor: '#EBEBEB',
      mutedTextColor: '#4A6060',
      colorMode: 'dark',
      galleryLayout: 'grid',
    };

    const migrated = migrateThemeConfig(fullPalette);

    expect(migrated.surfaceColor).toBe('#111414');
    expect(migrated.elevatedColor).toBe('#182222');
    expect(migrated.surfaceBorderColor).toBe('#1E2E2E');
    expect(migrated.mutedTextColor).toBe('#4A6060');
    expect(migrated.accentDarkColor).toBe('#014E4E');
  });

  it('still migrates the legacy "hero" galleryLayout while filling palette', () => {
    const legacy = {
      primaryColor: '#5C8762',
      accentColor: '#22c55e',
      backgroundColor: '#fafafa',
      textColor: '#171717',
      galleryLayout: 'hero',
    } as unknown as ThemeConfig;

    const migrated = migrateThemeConfig(legacy);

    expect(migrated.galleryLayout).toBe('grid');
    expect(migrated.headerStyle).toBe('hero');
    expect(migrated.heroDividerStyle).toBe('wave');
    // Palette still filled.
    expect(migrated.surfaceColor).toBe('#ffffff');
    expect(migrated.accentDarkColor).toBe('#5C8762');
  });
});

describe('applyForceColorMode', () => {
  const lightTheme: ThemeConfig = {
    primaryColor: '#5C8762',
    accentColor: '#22c55e',
    accentDarkColor: '#5C8762',
    backgroundColor: '#fafafa',
    surfaceColor: '#ffffff',
    elevatedColor: '#f5f5f5',
    surfaceBorderColor: '#e5e5e5',
    textColor: '#171717',
    mutedTextColor: '#737373',
    colorMode: 'light',
  };

  const customDark: ThemeConfig = {
    primaryColor: '#014E4E',
    accentColor: '#017C7C',
    accentDarkColor: '#014E4E',
    backgroundColor: '#0D0D0D',
    surfaceColor: '#111414',
    elevatedColor: '#182222',
    surfaceBorderColor: '#1E2E2E',
    textColor: '#EBEBEB',
    mutedTextColor: '#4A6060',
    colorMode: 'dark',
  };

  it('returns the theme unchanged when no force mode is set', () => {
    expect(applyForceColorMode(lightTheme, null)).toEqual(lightTheme);
    expect(applyForceColorMode(lightTheme, undefined)).toEqual(lightTheme);
  });

  it('only pins colorMode when the theme already matches the forced mode', () => {
    const result = applyForceColorMode(customDark, 'dark');
    expect(result.colorMode).toBe('dark');
    // Custom surfaces preserved.
    expect(result.backgroundColor).toBe('#0D0D0D');
    expect(result.surfaceColor).toBe('#111414');
    expect(result.accentColor).toBe('#017C7C');
  });

  it('swaps surface tokens when forcing a light theme to dark', () => {
    const result = applyForceColorMode(lightTheme, 'dark');
    expect(result.colorMode).toBe('dark');
    // Surfaces flipped to dark defaults.
    expect(result.backgroundColor).toBe('#0f0f0f');
    expect(result.surfaceColor).toBe('#1a1a1a');
    expect(result.elevatedColor).toBe('#242424');
    expect(result.surfaceBorderColor).toBe('#2e2e2e');
    expect(result.textColor).toBe('#e5e5e5');
    expect(result.mutedTextColor).toBe('#a3a3a3');
    // Brand identity preserved.
    expect(result.accentColor).toBe('#22c55e');
    expect(result.accentDarkColor).toBe('#5C8762');
  });

  it('swaps surface tokens when forcing a dark theme to light', () => {
    const result = applyForceColorMode(customDark, 'light');
    expect(result.colorMode).toBe('light');
    expect(result.backgroundColor).toBe('#fafafa');
    expect(result.surfaceColor).toBe('#ffffff');
    expect(result.textColor).toBe('#171717');
    // Custom accent colours survive the flip.
    expect(result.accentColor).toBe('#017C7C');
    expect(result.accentDarkColor).toBe('#014E4E');
  });
});
