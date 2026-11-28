/**
 * The website's Pages panel edits the legal and system pages (issue 2618):
 * the CMS pages the galleries, the website footer and the not-found address
 * show, through the same editor, not a copy.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : (fb as { defaultValue?: string })?.defaultValue ?? k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../components/admin/cms/CmsPageEditor', () => ({
  CmsPageEditor: ({ slug, saveMode, onDirtyChange }: { slug: string; saveMode: string; onDirtyChange?: (dirty: boolean) => void }) => (
    <div>
      {`editor:${slug}:${saveMode}`}
      <button type="button" onClick={() => onDirtyChange?.(true)}>type something</button>
    </div>
  ),
}));
const confirmMock = vi.fn();
vi.mock('../../../components/common/ConfirmDialog', () => ({ useConfirm: () => confirmMock }));
const page = (slug: string, title: string) => ({ id: 1, slug, title_en: title, title_de: title, content_en: '', content_de: '', logo_url: null, use_external_url: false, external_url: null, updated_at: '' });
vi.mock('../../../services/cms.service', () => ({
  cmsService: {
    getPages: () => Promise.resolve([
      page('agb', 'Terms'), page('datenschutz', 'Privacy'), page('gallery-not-found', 'Gallery not found'), page('impressum', 'Imprint'), page('not-found', 'Page not found'),
    ]),
  },
  LEGAL_PAGE_SLUGS: ['impressum', 'datenschutz', 'agb'],
}));

import { CmsPagesSection } from '../CmsPagesSection';

const renderSection = (readOnly = false, url = '/admin/website?panel=pages') => render(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={[url]}><CmsPagesSection readOnly={readOnly} /></MemoryRouter></QueryClientProvider>,
);

describe('legal and system pages in the website builder', () => {
  it('lists every CMS page, legal ones and system ones apart, and opens the CMS editor for each', async () => {
    renderSection();
    await screen.findByRole('button', { name: /Imprint/ });
    const legal = screen.getByRole('list', { name: 'Legal pages' });
    expect(within(legal).getAllByRole('button').map((b) => b.textContent)).toEqual(['Imprint/impressum', 'Privacy/datenschutz', 'Terms/agb']);
    const system = screen.getByRole('list', { name: 'System pages' });
    expect(within(system).getAllByRole('button').map((b) => b.textContent)).toEqual(['Page not found/not-found', 'Gallery not found/gallery-not-found']);
    for (const [name, slug] of [['Imprint', 'impressum'], ['Privacy', 'datenschutz'], ['Terms', 'agb'], ['Page not found', 'not-found'], ['Gallery not found', 'gallery-not-found']]) {
      // hidden: the editor of the page before is open over the list.
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`), hidden: true }));
      expect(screen.getByText(`editor:${slug}:inline`)).toBeInTheDocument();
    }
  });

  it('opens the page a link names (the CMS tab links here)', async () => {
    renderSection(false, '/admin/website?panel=pages&cms=not-found');
    expect(await screen.findByText('editor:not-found:inline')).toBeInTheDocument();
  });

  it('offers no editing without the right to change the website', async () => {
    renderSection(true);
    expect(await screen.findByRole('button', { name: /Imprint/ })).toBeDisabled();
  });

  it('asks before a close drops unsaved changes, and closes without asking when there are none', async () => {
    renderSection(false, '/admin/website?panel=pages&cms=impressum');
    expect(await screen.findByText('editor:impressum:inline')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('editor:impressum:inline')).toBeNull());
    expect(confirmMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Imprint/ }));
    fireEvent.click(screen.getByRole('button', { name: 'type something' }));
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('editor:impressum:inline')).toBeInTheDocument();
    confirmMock.mockResolvedValueOnce(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('editor:impressum:inline')).toBeNull());
  });
});
