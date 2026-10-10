import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ThemeConfig } from '../../types/theme.types';

/**
 * The portal and the public pages follow the operator's palette. The hook
 * used to set `.dark` from the visitor's OS preference alone and never took
 * it off again, so a light studio palette seen from a dark-mode OS got the
 * dark greys painted over it, and the quote/contract view embedded in the
 * portal left `.dark` behind on every portal page after it.
 */

let settings: { branding_force_color_mode?: 'dark' | 'light' | null } = {};
let theme: ThemeConfig | undefined;
let osDark = false;

vi.mock('../usePublicSettings', () => ({
  usePublicSettings: () => ({ data: settings }),
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useOptionalTheme: () => (theme ? { theme } : undefined),
}));

import { usePublicDarkMode, isPaletteDark } from '../usePublicDarkMode';

const LIGHT: ThemeConfig = {
  primaryColor: '#5C8762',
  accentColor: '#22c55e',
  backgroundColor: '#fbf7ee',
  textColor: '#2b2118',
  colorMode: 'light',
} as ThemeConfig;

const DARK: ThemeConfig = {
  primaryColor: '#5C8762',
  accentColor: '#22c55e',
  backgroundColor: '#101418',
  textColor: '#eeeeee',
  colorMode: 'dark',
} as ThemeConfig;

const html = () => document.documentElement.classList;

beforeEach(() => {
  settings = {};
  theme = undefined;
  osDark = false;
  html().remove('dark', 'public-ui');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? osDark : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  html().remove('dark', 'public-ui');
});

describe('usePublicDarkMode', () => {
  it('keeps a light studio palette light on a dark-mode OS', () => {
    theme = LIGHT;
    osDark = true;
    const { result } = renderHook(() => usePublicDarkMode());
    expect(result.current.isDark).toBe(false);
    expect(html().contains('dark')).toBe(false);
    expect(html().contains('public-ui')).toBe(true);
  });

  it('turns dark for a dark studio palette on a light-mode OS', () => {
    theme = DARK;
    osDark = false;
    const { result } = renderHook(() => usePublicDarkMode());
    expect(result.current.isDark).toBe(true);
    expect(html().contains('dark')).toBe(true);
  });

  it('follows Branding’s force-colour mode, as applyTheme does', () => {
    theme = LIGHT;
    settings = { branding_force_color_mode: 'dark' };
    const { result } = renderHook(() => usePublicDarkMode());
    expect(result.current.isDark).toBe(true);
    expect(html().contains('dark')).toBe(true);
  });

  it('takes its classes off <html> when the last page using it unmounts', () => {
    theme = DARK;
    const layout = renderHook(() => usePublicDarkMode());
    const embedded = renderHook(() => usePublicDarkMode());
    embedded.unmount();
    // The portal layout is still mounted: nothing is stripped yet.
    expect(html().contains('dark')).toBe(true);
    expect(html().contains('public-ui')).toBe(true);
    layout.unmount();
    expect(html().contains('dark')).toBe(false);
    expect(html().contains('public-ui')).toBe(false);
  });
});

describe('isPaletteDark', () => {
  it('reads the palette’s own colours before its colour mode', () => {
    expect(isPaletteDark({ ...LIGHT, colorMode: 'dark' }, null, false)).toBe(false);
    expect(isPaletteDark({ ...DARK, colorMode: 'light' }, null, true)).toBe(true);
  });

  it('falls back to the colour mode, then the OS, when the theme names no colour', () => {
    expect(isPaletteDark({ colorMode: 'dark' } as ThemeConfig, null, false)).toBe(true);
    expect(isPaletteDark({ colorMode: 'auto' } as ThemeConfig, null, true)).toBe(true);
    expect(isPaletteDark({ colorMode: 'light' } as ThemeConfig, null, true)).toBe(false);
    expect(isPaletteDark(undefined, null, true)).toBe(true);
  });
});
