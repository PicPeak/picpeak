/**
 * The CMS page editor inside the website builder's dialog: the dialog names
 * the page, so the editor does not repeat it; one Save; only the options
 * that apply to the kind of page; and a line saying these pages are saved
 * at once, not with the website draft behind the dialog.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: String, formatDateTime: String, formatTime: String }) }));
vi.mock('../../CMSEditor', () => ({
  CMSEditor: ({ content, onSave }: { content: string; onSave?: () => void }) => (
    <div>
      <textarea aria-label="content" value={content} readOnly />
      {onSave && <button type="button">toolbar save</button>}
    </div>
  ),
}));
vi.mock('../../SettingsSaveBar', () => ({ SettingsSaveBar: () => <div>save bar</div> }));
vi.mock('../../../../contexts/UnsavedChangesContext', () => ({ useUnsavedChanges: () => {} }));
const page = (slug: string) => ({ id: 1, slug, title_en: slug, title_de: slug, content_en: `<p>${slug}</p>`, content_de: '', logo_url: null, use_external_url: false, external_url: null, updated_at: '' });
vi.mock('../../../../services/cms.service', async (original) => ({
  ...(await original<typeof import('../../../../services/cms.service')>()),
  cmsService: {
    getPages: () => Promise.resolve([page('impressum'), page('not-found'), page('gallery-not-found')]),
    updatePage: vi.fn(), uploadPageLogo: vi.fn(), clearPageLogo: vi.fn(),
  },
}));

import { CmsPageEditor } from '../CmsPageEditor';

const open = async (slug: string, saveMode?: 'inline') => {
  render(<QueryClientProvider client={new QueryClient()}><CmsPageEditor slug={slug} saveMode={saveMode} /></QueryClientProvider>);
  await screen.findByDisplayValue(`<p>${slug}</p>`);
};

describe('CmsPageEditor in the website builder\'s dialog', () => {
  it('has no heading of its own, one Save, and says the page is saved at once', async () => {
    await open('impressum', 'inline');
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button', { name: 'toolbar save' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
    expect(screen.getByText(/apply as soon as they are saved/)).toBeInTheDocument();
  });

  it('a legal page keeps its external address, footer switch and logo', async () => {
    await open('impressum', 'inline');
    expect(screen.getByText('cms.useExternalUrl')).toBeInTheDocument();
    expect(screen.getByText('Show in gallery footer')).toBeInTheDocument();
    expect(screen.getByText('Page Logo')).toBeInTheDocument();
  });

  it('the not-found page offers neither an external address, a footer switch nor a logo', async () => {
    await open('not-found', 'inline');
    expect(screen.queryByText('cms.useExternalUrl')).toBeNull();
    expect(screen.queryByText('Show in gallery footer')).toBeNull();
    // The website shows it under its own header.
    expect(screen.queryByText('Page Logo')).toBeNull();
  });

  it('the gallery-not-found page keeps its logo: it is shown in the gallery\'s frame', async () => {
    await open('gallery-not-found', 'inline');
    expect(screen.queryByText('cms.useExternalUrl')).toBeNull();
    expect(screen.queryByText('Show in gallery footer')).toBeNull();
    expect(screen.getByText('Page Logo')).toBeInTheDocument();
  });

  it('the CMS tab keeps the editor as it is: heading, toolbar Save, save bar', async () => {
    await open('not-found');
    expect(screen.getByRole('heading')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'toolbar save' })).toBeInTheDocument();
    expect(screen.getByText('save bar')).toBeInTheDocument();
    expect(screen.getByText('Show in gallery footer')).toBeInTheDocument();
  });
});
