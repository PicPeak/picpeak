/**
 * The app's own not-found and gallery-not-found pages: one heading. The CMS
 * text of these pages starts with its heading, so the page's name is not
 * printed above it a second time.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: { default_language: 'en' } }) }));
vi.mock('../../../hooks/useShowAgbLink', () => ({ useShowAgbLink: () => false }));
vi.mock('../PoweredBy', () => ({ PoweredBy: () => null }));
const getPublicPage = vi.fn();
vi.mock('../../../services/cms.service', () => ({ cmsService: { getPublicPage: (...args: unknown[]) => getPublicPage(...args) } }));

import { CMSContentBlock } from '../CMSContentBlock';

const open = async (page: { title: string; content: string }) => {
  getPublicPage.mockResolvedValue({ slug: 'not-found', logo_url: null, ...page });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><CMSContentBlock slug="not-found" /></MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  return screen.getAllByRole('heading').map((h) => `${h.tagName}:${h.textContent}`);
};

describe('CMSContentBlock', () => {
  it('shows the heading the text starts with as the page\'s one heading', async () => {
    expect(await open({ title: 'Page Not Found', content: '<h2>Page Not Found</h2><p>The page does not exist.</p>' })).toEqual(['H1:Page Not Found']);
    expect(screen.getByText('The page does not exist.')).toBeInTheDocument();
  });

  it('shows the page\'s name when the text has no heading of its own', async () => {
    expect(await open({ title: 'Page Not Found', content: '<p>Nothing lives here.</p>' })).toEqual(['H1:Page Not Found']);
  });

  it('keeps headings further down in the text', async () => {
    expect(await open({ title: 'Page Not Found', content: '<h2>Lost?</h2><p>Text</p><h3>Try this</h3>' })).toEqual(['H1:Lost?', 'H3:Try this']);
  });
});
