/**
 * Stable's Tailwind config defines `primary` only as a shade scale (50-900),
 * with no DEFAULT. A bare `bg-primary`, `border-primary`, `text-primary` or
 * `ring-primary` is therefore never generated: the restore wizard's step
 * circles and progress bar rendered without a colour.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const BARE = /(?<![\w:-])(?:(?:focus|hover):)?(?:bg|border|text|ring)-primary(?=['"\s`}])/g;

describe('admin backup screens use generated primary shades', () => {
  it.each(['RestoreWizard.jsx', 'BackupHistory.jsx'])('%s has no bare primary utility', (file) => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/admin', file), 'utf8');
    expect(source.match(BARE) || []).toEqual([]);
  });
});
