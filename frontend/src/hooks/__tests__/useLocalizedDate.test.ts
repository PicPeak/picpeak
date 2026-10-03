/**
 * useLocalizedDate knew date-fns locales for de, pt and fr only, so Spanish,
 * Dutch, Russian and Slovenian screens got English month names and relative
 * times, and a regional tag such as `de-DE` fell to English as well. The
 * hook now resolves every shipped UI locale by its base language.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

let language = 'en';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language } }),
}));

vi.mock('../usePublicSettings', () => ({
  usePublicSettings: () => ({ data: undefined }),
}));

import { useLocalizedDate } from '../useLocalizedDate';

// 2026-03-04 is a Wednesday.
const date = new Date(2026, 2, 4, 12, 0, 0);

describe('useLocalizedDate locale resolution', () => {
  it.each([
    ['de', 'März', 'Mittwoch'],
    ['en', 'March', 'Wednesday'],
    ['es', 'marzo', 'miércoles'],
    ['fr', 'mars', 'mercredi'],
    ['nl', 'maart', 'woensdag'],
    ['pt', 'março', 'quarta-feira'],
    ['ru', 'марта', 'среда'],
    ['sl', 'marec', 'sreda'],
    ['de-DE', 'März', 'Mittwoch'],
    ['pt-BR', 'março', 'quarta-feira'],
  ])('%s → month %s, weekday %s', (lang, month, weekday) => {
    language = lang;
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format(date, 'd MMMM yyyy')).toContain(month);
    expect(result.current.format(date, 'EEEE')).toBe(weekday);
  });

  it('falls back to English for an unknown language', () => {
    language = 'xx';
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format(date, 'EEEE')).toBe('Wednesday');
  });

  it('localises relative times too', () => {
    language = 'nl';
    const { result } = renderHook(() => useLocalizedDate());
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(result.current.formatDistanceToNow(twoDaysAgo, { addSuffix: true })).toBe('2 dagen geleden');
  });
});
