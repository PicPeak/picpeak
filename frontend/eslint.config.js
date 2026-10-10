import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'
import { findTokenPairs } from './scripts/ui-tokens-map.mjs'
import { rewritePalette, PALETTE_RE } from './scripts/ui-palette-map.mjs'

// Admin code styles through the UI tokens (src/styles/tokens.css, STYLING.md):
// bg-panel, text-body, border-line, ... flip with .dark on their own. A raw
// `bg-white dark:bg-neutral-800` pair is a component managing its own dark
// palette again, which the tokens exist to end. The rule flags exactly the
// pairs `npm run codemod:ui-tokens` rewrites — run it, or pick the token from
// the table in STYLING.md. Opacity modifiers, mixed pairs and dark-only
// classes have no token and pass.
const uiTokensPlugin = {
  rules: {
    'no-raw-dark-palette': {
      meta: { type: 'suggestion', fixable: 'code', docs: { description: 'use the UI token utilities instead of light/dark neutral pairs' } },
      create(context) {
        // The fixer rewrites the whole class list at once (several pairs can
        // share one string); scripts/codemod-ui-tokens.mjs runs exactly this
        // fix over the admin scope.
        const check = (node, text) => {
          if (!text.includes('dark:')) return
          const { toks, hits } = findTokenPairs(text)
          if (hits.length === 0) return
          for (const h of hits) {
            toks[h.lightIndex] = h.replacement
            toks[h.darkIndex] = ''
            if (h.darkIndex > 0 && /^\s+$/.test(toks[h.darkIndex - 1])) toks[h.darkIndex - 1] = ''
          }
          const fixed = toks.join('')
          const fix = (fixer) => {
            const raw = context.sourceCode.getText(node)
            const i = raw.indexOf(text)
            return i < 0 ? null : fixer.replaceText(node, raw.slice(0, i) + fixed + raw.slice(i + text.length))
          }
          for (const h of hits) {
            context.report({ node, fix, message: `"${h.light} ${h.dark}" has a UI token: use "${h.replacement}" (frontend/STYLING.md, or npm run codemod:ui-tokens)` })
          }
        }
        return {
          Literal(node) { if (typeof node.value === 'string') check(node, node.value) },
          TemplateElement(node) { check(node, node.value.raw) },
        }
      },
    },
    // Every colour comes from tokens.css (STYLING.md › Colour classes): a raw
    // `text-red-600` or `bg-primary-600` is a colour nobody can change in one
    // place. Classes whose meaning is clear are rewritten by the fix (status
    // hues → success/warning/danger/info, primary → accent, focus rings →
    // accent); the rest is reported for a person to pick a token.
    'no-raw-palette': {
      meta: { type: 'suggestion', fixable: 'code', docs: { description: 'use the colour tokens instead of raw Tailwind palette classes' } },
      create(context) {
        const check = (node, text) => {
          if (!/-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary|sand)-\d/.test(text)) return
          if (!text.split(/\s+/).some((t) => PALETTE_RE.test(t))) return
          const { next, changed, unmapped } = rewritePalette(text)
          const fix = changed
            ? (fixer) => {
              const raw = context.sourceCode.getText(node)
              const i = raw.indexOf(text)
              return i < 0 ? null : fixer.replaceText(node, raw.slice(0, i) + next + raw.slice(i + text.length))
            }
            : null
          if (changed) context.report({ node, fix, message: 'Raw palette colour has a token (npm run codemod:ui-tokens, STYLING.md › Colour classes)' })
          for (const cls of unmapped) {
            context.report({ node, message: `"${cls}" is not a token colour: use a status (success/warning/danger/info/storno), a data colour (chart-1…8), the accent or a neutral token (STYLING.md › Colour classes)` })
          }
        }
        return {
          Literal(node) { if (typeof node.value === 'string') check(node, node.value) },
          TemplateElement(node) { check(node, node.value.raw) },
        }
      },
    },
  },
}

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-useless-escape': 'off',
      'no-case-declarations': 'off',
      'prefer-const': 'off',
      'no-control-regex': 'off',
      'no-useless-catch': 'off',
      'react-refresh/only-export-components': 'off',
      'no-empty': 'off',
      'no-debugger': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
  {
    files: [
      'src/components/admin/**/*.{ts,tsx}',
      'src/pages/admin/**/*.{ts,tsx}',
      'src/features/**/*.{ts,tsx}',
      'src/components/common/**/*.{ts,tsx}',
    ],
    plugins: { 'ui-tokens': uiTokensPlugin },
    rules: { 'ui-tokens/no-raw-dark-palette': 'error' },
  },
  {
    // Colours, everywhere in the app: one source (src/styles/tokens.css).
    files: ['src/**/*.{ts,tsx,jsx}'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.{ts,tsx}'],
    // The .jsx files have no other config block, so JSX parsing is set here.
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'ui-tokens': uiTokensPlugin },
    rules: { 'ui-tokens/no-raw-palette': 'error' },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
])
