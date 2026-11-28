/**
 * The CMS page editor inside the website builder's dialog (inline save, no
 * SettingsSaveBar) still tells the admin's leave guard about unsaved edits,
 * so a reload, a tab close or browser Back asks first (issue 2618).
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }) }));
vi.mock('../../CMSEditor', () => ({
  CMSEditor: ({ content, onChange }: { content: string; onChange: (v: string) => void }) => <textarea aria-label="content" value={content} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock('../../SettingsSaveBar', () => ({ SettingsSaveBar: () => <div>save bar</div> }));
const guard = vi.fn();
vi.mock('../../../../contexts/UnsavedChangesContext', () => ({ useUnsavedChanges: (dirty: boolean) => guard(dirty) }));
vi.mock('../../../../services/cms.service', async (original) => ({
  ...(await original<typeof import('../../../../services/cms.service')>()),
  cmsService: {
    getPages: () => Promise.resolve([{ id: 1, slug: 'impressum', title_en: 'Imprint', title_de: 'Impressum', content_en: '<p>a</p>', content_de: '', logo_url: null, use_external_url: false, external_url: null, updated_at: '' }]),
    updatePage: vi.fn(), uploadPageLogo: vi.fn(), clearPageLogo: vi.fn(),
  },
}));

import { CmsPageEditor } from '../CmsPageEditor';

describe('CmsPageEditor leave guard', () => {
  it('registers its unsaved edits in inline mode', async () => {
    render(<QueryClientProvider client={new QueryClient()}><CmsPageEditor slug="impressum" saveMode="inline" /></QueryClientProvider>);
    // Once the page has loaded into the form.
    const box = await screen.findByDisplayValue('<p>a</p>');
    fireEvent.change(box, { target: { value: '<p>changed</p>' } });
    expect(guard).toHaveBeenLastCalledWith(true);
  });

  it('leaves it to the save bar in bar mode (one registration)', async () => {
    guard.mockClear();
    render(<QueryClientProvider client={new QueryClient()}><CmsPageEditor slug="impressum" /></QueryClientProvider>);
    // Once the page has loaded into the form.
    const box = await screen.findByDisplayValue('<p>a</p>');
    fireEvent.change(box, { target: { value: '<p>changed</p>' } });
    expect(guard).not.toHaveBeenCalledWith(true);
  });
});
