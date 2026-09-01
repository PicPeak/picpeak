/**
 * SettingsPage renders a section heading (icon + nav label + divider) for
 * every tab that isn't listed in its own TABS_WITH_OWN_HEADER escape hatch.
 * Several tab components ALSO rendered a page-level title of their own, so
 * the admin saw the same heading twice, stacked (QA warning).
 *
 * The duplicate was removed on the component side — the shell heading is the
 * one that is consistent across all ~20 tabs and always matches the nav item
 * the admin just clicked. Source-inspection guard so it doesn't come back.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

import en from '../../../i18n/locales/en.json';

const SRC = path.resolve(__dirname, '../../..');

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const translate = (key: string): string | undefined => {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Tabs that lean on the shell heading, and the component each one mounts. */
const SHELL_HEADING_TABS = [
  { tab: 'downloads', labelKey: 'settings.downloads.title', file: 'features/settings/tabs/DownloadsTab.tsx' },
  { tab: 'sso', labelKey: 'settings.sso.title', file: 'features/settings/tabs/SsoTab.tsx' },
  { tab: 'apiTokens', labelKey: 'settings.apiTokens.title', file: 'features/settings/tabs/ApiTokensTab.tsx' },
  { tab: 'webhooks', labelKey: 'settings.webhooks.title', file: 'features/settings/tabs/WebhooksTab.tsx' },
  { tab: 'accounting', labelKey: 'settings.accounting.title', file: 'features/settings/tabs/AccountingTab.tsx' },
  { tab: 'whatsapp', labelKey: 'settings.whatsapp.title', file: 'features/settings/tabs/WhatsAppTab.tsx' },
  { tab: 'moderation', labelKey: 'settings.moderation.title', file: 'components/admin/WordFilterManager.tsx' },
  { tab: 'styling', labelKey: 'settings.styling.title', file: 'components/admin/CssTemplateEditor.tsx' },
  { tab: 'slideshow', labelKey: 'settings.slideshow.title', file: 'pages/admin/SlideshowSettingsPage.tsx' },
  { tab: 'businessProfile', labelKey: 'settings.businessProfile.title', file: 'pages/admin/settings/SettingsBusinessProfilePage.tsx' },
  { tab: 'crm', labelKey: 'settings.crm.title', file: 'pages/admin/settings/CrmSettingsPage.tsx' },
];

/**
 * The three tabs whose own title merely paraphrased the nav label ("Word
 * Filters" under "Moderation") rather than repeating it verbatim, so the
 * label comparison above can't catch a regression on them.
 */
const PARAPHRASED_TITLE_KEYS = [
  { file: 'components/admin/WordFilterManager.tsx', key: 'settings.moderation.wordFilters' },
  { file: 'components/admin/CssTemplateEditor.tsx', key: 'cssTemplates.title' },
  { file: 'pages/admin/settings/CrmSettingsPage.tsx', key: 'crmSettings.title' },
];

const HEADING = /<(h[12])\b[^>]*>([\s\S]*?)<\/\1>/g;
// Captures the key and, when present, the inline English default. Several of
// these keys live only as defaults (`businessProfile.title` is not in en.json
// at all), so resolving against the locale file alone would miss them.
const T_CALL = /\bt\(\s*'([^']+)'(?:\s*,\s*'((?:[^'\\]|\\.)*)')?/g;

const resolve = (key: string, fallback?: string) => translate(key) ?? fallback;

describe('settings tabs render exactly one section heading', () => {
  it.each(SHELL_HEADING_TABS)(
    '$tab does not repeat its nav label inside the tab body',
    ({ labelKey, file }) => {
      const label = translate(labelKey);
      expect(label, `${labelKey} missing from en.json`).toBeTruthy();

      const offenders: string[] = [];
      for (const heading of read(file).matchAll(HEADING)) {
        for (const call of heading[2].matchAll(T_CALL)) {
          const resolved = resolve(call[1], call[2]);
          if (resolved && normalize(resolved) === normalize(label as string)) {
            offenders.push(call[1]);
          }
        }
      }

      expect(offenders).toEqual([]);
    },
  );

  it.each(PARAPHRASED_TITLE_KEYS)('$file no longer renders $key as a title', ({ file, key }) => {
    expect(read(file)).not.toContain(`t('${key}'`);
  });

  it('keeps these tabs out of SettingsPage.TABS_WITH_OWN_HEADER', () => {
    // The fix must stay on the component side: adding the tabs to the skip
    // list would drop the shell heading and lose the icon + divider that
    // every other tab shows.
    const declaration = /TABS_WITH_OWN_HEADER: TabType\[\] = \[([^\]]*)\]/
      .exec(read('pages/admin/SettingsPage.tsx'))?.[1];
    expect(declaration).toBeTruthy();

    const skipped = Array.from((declaration as string).matchAll(/'([^']+)'/g), (m) => m[1]);
    for (const { tab } of SHELL_HEADING_TABS) {
      expect(skipped).not.toContain(tab);
    }
  });
});
