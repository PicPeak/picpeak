#!/usr/bin/env node
/**
 * Rewrite hand-managed light/dark Tailwind pairs to the UI token utilities.
 *
 *   text-neutral-500 dark:text-neutral-400     ->  text-muted
 *   bg-white dark:bg-neutral-800               ->  bg-panel
 *   border-neutral-200 dark:border-neutral-700 ->  border-line
 *
 * This is the autofix of the `ui-tokens/no-raw-dark-palette` rule in
 * eslint.config.js, applied on its own over the admin scope, so the rule and
 * the codemod can never disagree. Only a class with a `dark:` partner for the
 * same property in the same string is rewritten; a lone `text-neutral-400` is
 * left alone (mapping it would add a dark value it never had), and so are
 * pairs with an opacity modifier (`dark:bg-neutral-800/60` — the tokens are
 * plain hex) and mixed pairs (a coloured light class with a neutral dark one).
 *
 * Idempotent and re-runnable — run it again after a rebase:
 *   npm run codemod:ui-tokens            # rewrite
 *   npm run codemod:ui-tokens -- --check # report only, exit 1 if anything is left
 *
 * The table lives in scripts/ui-tokens-map.mjs; frontend/STYLING.md documents it.
 */
import { ESLint } from 'eslint';

const RULE = 'ui-tokens/no-raw-dark-palette';
const SCOPE = [
  'src/components/admin',
  'src/pages/admin',
  'src/features',
  'src/components/common',
];

const check = process.argv.includes('--check');

// Pass 1: count what the rule reports (before any fix is applied).
const reporter = new ESLint({ ruleFilter: ({ ruleId }) => ruleId === RULE });
const before = await reporter.lintFiles(SCOPE);
let pairs = 0;
const files = new Set();
for (const r of before) {
  const n = r.messages.filter((m) => m.ruleId === RULE).length;
  if (n > 0) { pairs += n; files.add(r.filePath); }
}

// Pass 2: apply only this rule's fixer.
if (!check && pairs > 0) {
  const fixer = new ESLint({ fix: (m) => m.ruleId === RULE, ruleFilter: ({ ruleId }) => ruleId === RULE });
  await ESLint.outputFixes(await fixer.lintFiles(SCOPE));
}

console.log(`${check ? 'would rewrite' : 'rewrote'} ${pairs} pairs in ${files.size} files (scope: ${SCOPE.join(', ')})`);
if (check && pairs > 0) process.exit(1);
