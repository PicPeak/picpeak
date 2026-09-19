/**
 * The customer portal must not style anything with Tailwind's `dark:`
 * modifier (#1444).
 *
 * `darkMode: 'class'` matches a `dark` class on an ancestor, which only the
 * admin shell and the public gallery set. The portal renders the
 * photographer's branding palette through CSS tokens instead, so every
 * `dark:` class under `pages/customer` is dead: the light half of the pair
 * shows on a dark portal, and no unit test that merely reads the class string
 * can tell.
 *
 * A source check rather than a render check, because that is the shape of the
 * mistake — it is invisible in jsdom and only appears in a screenshot.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Strip comments: the explanations of this rule name `dark:` themselves. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

it('styles no customer-portal element with a dark: variant', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(DIR)) {
    code(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (/\bdark:/.test(line)) offenders.push(`${path.basename(file)}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  expect(offenders).toEqual([]);
});

it('uses the token-derived status classes for every coloured status', () => {
  // The replacement, so a later "fix" that reaches back for a fixed Tailwind
  // colour shows up here rather than in a screenshot six weeks later.
  const fixedColour = /\b(bg|text)-(green|red|amber|blue|purple)-\d{2,3}\b/;
  const offenders: string[] = [];
  for (const file of sourceFiles(DIR)) {
    code(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (fixedColour.test(line)) offenders.push(`${path.basename(file)}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  expect(offenders).toEqual([]);
});
