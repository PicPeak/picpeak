import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../config';
import en from '../locales/en.json';
import de from '../locales/de.json';

describe('bundled translations with the patched HTTP backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses bundled English, German and regional fallback without HTTP requests', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage('en');
      expect(i18n.t('productUsagePrompt.title')).toBe(en.productUsagePrompt.title);
      await i18n.changeLanguage('de');
      expect(i18n.t('productUsagePrompt.title')).toBe(de.productUsagePrompt.title);
      await i18n.changeLanguage('de-DE');
      expect(i18n.t('productUsagePrompt.title')).toBe(de.productUsagePrompt.title);
      await i18n.changeLanguage('xx');
      expect(i18n.t('productUsagePrompt.title')).toBe(en.productUsagePrompt.title);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await i18n.changeLanguage(previousLanguage || 'en');
    }
  });
});
