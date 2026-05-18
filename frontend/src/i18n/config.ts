import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

import enTranslations from './locales/en.json';
import deTranslations from './locales/de.json';
import ruTranslations from './locales/ru.json';
import ptTranslations from './locales/pt.json';
import nlTranslations from './locales/nl.json';
import frTranslations from './locales/fr.json';

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    debug: false,

    resources: {
      en: {
        translation: enTranslations,
      },
      de: {
        translation: deTranslations,
      },
      ru: {
        translation: ruTranslations,
      },
      pt: {
        translation: ptTranslations,
      },
      nl: {
        translation: nlTranslations,
      },
      fr: {
        translation: frTranslations,
      },
    },

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
