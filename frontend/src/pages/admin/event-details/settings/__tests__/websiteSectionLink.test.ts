/**
 * `?section=website` opens the Public website section of a gallery's settings
 * (issue 2618): the details page accepts only the section keys it lists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('accepts the website section in the URL', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../EventDetailsPage.tsx'), 'utf8');
  const keys = source.match(/const SECTION_KEYS: SettingsSectionKey\[\] = \[([^\]]*)\]/);
  expect(keys?.[1]).toContain("'website'");
});
