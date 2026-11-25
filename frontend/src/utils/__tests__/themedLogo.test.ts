import { describe, expect, it } from 'vitest';
import { pickThemedLogo } from '../themedLogo';

describe('pickThemedLogo', () => {
  it.each([
    // isDark, light, dark, expected
    [false, '/light.png', '/dark.png', '/light.png'],
    [true, '/light.png', '/dark.png', '/dark.png'],
    [false, undefined, '/dark.png', '/dark.png'],
    [true, '/light.png', undefined, '/light.png'],
    [false, '', '/dark.png', '/dark.png'],
    [true, '/light.png', '', '/light.png'],
    [false, undefined, undefined, undefined],
    [true, undefined, undefined, undefined],
    [true, '', undefined, ''],
    [false, undefined, '', ''],
    [true, undefined, '', undefined],
    [false, null, null, null],
  ] as const)('isDark=%s light=%s dark=%s -> %s', (isDark, light, dark, expected) => {
    expect(pickThemedLogo(isDark, light, dark)).toBe(expected);
  });
});
