import { describe, expect, it, vi } from 'vitest';
import { resolveEventTheme } from '../resolveEventTheme';
import { GALLERY_THEME_PRESETS, type ThemeConfig } from '../../types/theme.types';

const global = { primaryColor: '#123456' } as ThemeConfig;

describe('resolveEventTheme', () => {
  it('parses an event theme stored as JSON', () => {
    expect(resolveEventTheme('{"accentColor":"#ff0000"}', global)).toEqual({ accentColor: '#ff0000' });
  });

  it('returns the preset an event names, as the shared object', () => {
    const [name, preset] = Object.entries(GALLERY_THEME_PRESETS)[0];
    expect(resolveEventTheme(name, global)).toBe(preset.config);
  });

  it('falls back to the global theme for no theme or an unknown name', () => {
    expect(resolveEventTheme(undefined, global)).toBe(global);
    expect(resolveEventTheme('', global)).toBe(global);
    expect(resolveEventTheme('no-such-preset', global)).toBe(global);
  });

  it('falls back to the global theme on broken JSON and reports it', () => {
    const onParseError = vi.fn();
    expect(resolveEventTheme('{broken', global, onParseError)).toBe(global);
    expect(onParseError).toHaveBeenCalledTimes(1);
  });

  it('is null without any theme to apply', () => {
    expect(resolveEventTheme(undefined, undefined)).toBeNull();
    expect(resolveEventTheme('no-such-preset', null)).toBeNull();
  });
});
