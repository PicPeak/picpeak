import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'
import { findTokenPairs } from './scripts/ui-tokens-map.mjs'

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
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
])
