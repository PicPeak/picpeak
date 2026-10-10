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

// Each rule with the files it covers (eslint.config.js).
const RULES = [
  ['ui-tokens/no-raw-dark-palette', ['src/components/admin', 'src/pages/admin', 'src/features', 'src/components/common']],
  ['ui-tokens/no-raw-palette', ['src']],
];

const check = process.argv.includes('--check');

let left = 0;
for (const [RULE, SCOPE] of RULES) {
  // Pass 1: count what the rule can fix (before any fix is applied).
  const reporter = new ESLint({ ruleFilter: ({ ruleId }) => ruleId === RULE });
  const before = await reporter.lintFiles(SCOPE);
  let fixable = 0;
  let manual = 0;
  const files = new Set();
  for (const r of before) {
    for (const m of r.messages.filter((msg) => msg.ruleId === RULE)) {
      if (m.fix) { fixable += 1; files.add(r.filePath); } else manual += 1;
    }
  }

  // Pass 2: apply only this rule's fixer.
  if (!check && fixable > 0) {
    const fixer = new ESLint({ fix: (m) => m.ruleId === RULE, ruleFilter: ({ ruleId }) => ruleId === RULE });
    await ESLint.outputFixes(await fixer.lintFiles(SCOPE));
  }

  console.log(`${RULE}: ${check ? 'would rewrite' : 'rewrote'} ${fixable} class lists in ${files.size} files`
    + (manual ? `; ${manual} classes need a person to pick a token` : ''));
  left += fixable + manual;
}
if (check && left > 0) process.exit(1);
