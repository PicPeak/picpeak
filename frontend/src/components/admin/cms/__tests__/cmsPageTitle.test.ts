/**
 * A CMS page's name in the admin: the interface's own name for the pages it
 * knows (so a German interface does not show "Page not found"), else the
 * page's own title in the interface language.
 */
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import en from '../../../../i18n/locales/en.json';
import de from '../../../../i18n/locales/de.json';
import { cmsPageTitle } from '../cmsPageTitle';

const tOf = (tree: { legal: Record<string, string> }) => ((key: string, options?: { defaultValue?: string }) => {
  const own = key.startsWith('legal.') ? tree.legal[key.slice('legal.'.length)] : undefined;
  return own ?? options?.defaultValue ?? key;
}) as unknown as TFunction;

describe('cmsPageTitle', () => {
  it.each(['impressum', 'datenschutz', 'agb', 'not-found', 'gallery-not-found'])('names %s in English and in German', (slug) => {
    const page = { title_en: 'Stored English title', title_de: 'Gespeicherter Titel' };
    expect(cmsPageTitle(tOf(en), 'en', slug, page)).toBe((en.legal as Record<string, string>)[slug]);
    expect(cmsPageTitle(tOf(de), 'de', slug, page)).toBe((de.legal as Record<string, string>)[slug]);
    expect((de.legal as Record<string, string>)[slug]).toBeTruthy();
  });

  it('falls back to the page\'s title in the interface language, then English, then the address', () => {
    const page = { title_en: 'Opening hours', title_de: 'Öffnungszeiten' };
    expect(cmsPageTitle(tOf(de), 'de-CH', 'hours', page)).toBe('Öffnungszeiten');
    expect(cmsPageTitle(tOf(en), 'en', 'hours', page)).toBe('Opening hours');
    expect(cmsPageTitle(tOf(de), 'de', 'hours', { title_en: 'Opening hours', title_de: '' })).toBe('Opening hours');
    expect(cmsPageTitle(tOf(en), 'en', 'hours')).toBe('hours');
  });
});
