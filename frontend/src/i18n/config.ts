import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

const localeFiles = import.meta.glob<Record<string, string>>('./locales/*.json', { eager: true, import: 'default' });

const resources = Object.fromEntries(
  Object.entries(localeFiles).map(([path, translations]) => {
    const lang = path.match(/\/(\w+)\.json$/)?.[1];
    return [lang, { translation: translations }];
  })
);

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    debug: false,

    resources,

    interpolation: {
      escapeValue: false,
    },

    // Use v4 format for pluralization (_one/_other instead of _plural suffix)
    compatibilityJSON: 'v4',

    detection: {
      order: ['localStorage', 'cookie', 'navigator', 'htmlTag'],
      caches: ['localStorage', 'cookie'],
    },
  });

export default i18n;
