import { defineConfig } from 'i18next-cli';
import { typescriptPlugin } from "./scripts/i18nextExtractionHelper";


export default defineConfig({
  // Only the locales that are kept at full key parity are managed by the extractor.
  // nl/pt/ru/fr/sl/es are deliberately partial and rely on `fallbackLng: 'en'`; letting
  // the extractor own them would fill each file with ~2700 empty-string values, and
  // i18next's default `returnEmptyString: true` renders those as blank UI instead of
  // falling back to English.
  locales: ['en', 'de'],

  extract: {
    input: ['src/**/*.{ts,tsx,js,jsx}'],
    // `glob` (used by i18next-cli) ignores `!`-prefixed entries inside `input`,
    // so exclusions have to live here or they are silently no-ops.
    ignore: [
      'src/**/*.{test,spec}.{ts,tsx,js,jsx}',
      'src/**/__tests__/**',
      'src/**/*.d.ts',
    ],
    output: 'src/i18n/locales/{{language}}.json',
    defaultNS: false,

    primaryLanguage: 'en',

    // Pruning is unsafe in this codebase: a large share of keys is never visible to the
    // AST extractor because it is built at runtime — t(`admin.activities.${type}`),
    // t(`admin.notificationMessages.${type}`), t(`projects.status.${status}`) — or held in
    // constant tables the extractor does not resolve (AdminSidebar `nameKey`,
    // CrmDevelopmentPage `titleKey`/`descKey`, the crmSettings toggle map). Enabling it
    // deletes ~355 live keys per locale, so removal stays a manual decision.
    removeUnusedKeys: false,

    preserveContextVariants: true,

    indentation: 2,
    sort: false,
  },
  plugins: [typescriptPlugin(["./src/App.tsx"]) ]
});