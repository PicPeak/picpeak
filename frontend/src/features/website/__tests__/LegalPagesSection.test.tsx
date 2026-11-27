/**
 * The website's Pages panel edits the legal pages (issue 2618): the CMS pages
 * the galleries link to, through the same editor, not a copy.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : (fb as { defaultValue?: string })?.defaultValue ?? k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../components/admin/cms/CmsPageEditor', () => ({
  CmsPageEditor: ({ slug, saveMode }: { slug: string; saveMode: string }) => <div>{`editor:${slug}:${saveMode}`}</div>,
}));
const page = (slug: string, title: string) => ({ id: 1, slug, title_en: title, title_de: title, content_en: '', content_de: '', logo_url: null, use_external_url: false, external_url: null, updated_at: '' });
vi.mock('../../../services/cms.service', () => ({
  cmsService: { getPages: () => Promise.resolve([page('impressum', 'Imprint'), page('datenschutz', 'Privacy'), page('gallery-not-found', 'Not found')]) },
  LEGAL_PAGE_SLUGS: ['impressum', 'datenschutz', 'agb'],
}));

import { LegalPagesSection } from '../LegalPagesSection';

const renderSection = (readOnly = false) => render(
  <QueryClientProvider client={new QueryClient()}><LegalPagesSection readOnly={readOnly} /></QueryClientProvider>,
);

describe('legal pages in the website builder', () => {
  it('lists the legal pages, not the other CMS pages, and opens the CMS editor for one', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /Imprint/ }));
    expect(screen.getByText('editor:impressum:inline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Privacy/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Not found/ })).toBeNull();
  });

  it('offers no editing without the right to change the website', async () => {
    renderSection(true);
    expect(await screen.findByRole('button', { name: /Imprint/ })).toBeDisabled();
  });
});
