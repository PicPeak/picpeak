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

    // Pruning is unsafe in this codebase. A large share of keys is never visible to the
    // AST extractor because it is built at runtime — 82 distinct dynamic key templates in
    // src, e.g. admin.activities, admin.notificationMessages, projects.status,
    // accounting.expenseStatus, crmSettings — or held in constant tables the extractor does
    // not resolve (AdminSidebar `nameKey`, CrmDevelopmentPage `titleKey`/`descKey`).
    // Turned on as-is, it deletes 422 keys per locale, 203 of which src references.
    //
    // A `preservePatterns` rescue was attempted and measured: 61 globs derived
    // mechanically from every dynamic template in src, plus 17 for the constant-table
    // prefixes (78 patterns). That still leaves two unfixable problems:
    //
    //  1. 47 of the remaining 158 removals are the base form of a plural key
    //     (`upload.failures.title` next to `_one`/`_other`). src passes exactly those
    //     strings to t(), so they are referenced by any honest definition. i18next happens
    //     to resolve them via the `_other` suffix first, so nothing breaks today — but
    //     covering them needs 47 literal patterns and one more on every future {{count}}
    //     key, where forgetting one silently deletes a live key. That is the exact failure
    //     mode this flag is supposed to prevent.
    //  2. Pruning is not idempotent. `extract` had to be run three times in a row before
    //     `extract --ci --dry-run` came back clean — each pass uncovered one further
    //     removal (`businessProfile.title`, then `cssTemplates.title`). i18n:ci would
    //     therefore fail on a correct tree until someone happened to run extract enough
    //     times. With pruning off the extractor settles in a single pass.
    //
    // Key removal stays a manual decision.
    removeUnusedKeys: false,

    preserveContextVariants: true,

    indentation: 2,
    sort: false,
  },
  plugins: [typescriptPlugin(["./src/App.tsx"]) ]
});