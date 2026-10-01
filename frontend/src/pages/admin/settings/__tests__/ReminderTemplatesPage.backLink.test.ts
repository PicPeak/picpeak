/**
 * The reminder templates back arrow must stay inside the admin (main PR 1730).
 *
 * Settings has no child path routes — tabs are selected with `?tab=` — so a
 * link to `/admin/settings/<anything>` matches nothing, falls through to the
 * global catch-all and renders the public not-found page outside the admin
 * chrome. Source-inspection guard, like brandingThemeTextLeak.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../ReminderTemplatesPage.tsx'), 'utf8');

describe('ReminderTemplatesPage back link', () => {
  it('points at the CRM settings tab, not a settings child path', () => {
    expect(source).toContain('to="/admin/settings?tab=crm"');
    expect(source).not.toMatch(/to="\/admin\/settings\/[a-z]/);
  });
});
