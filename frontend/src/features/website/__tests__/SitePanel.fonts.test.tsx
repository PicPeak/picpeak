/**
 * The website's fonts come from the fonts the install has; the Design panel
 * links to where they are uploaded (issue 2618).
 */
import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../services/fonts.service', () => ({ fontsService: { list: vi.fn().mockResolvedValue([]) }, FONTS_QUERY_KEY: ['fonts'] }));

import { SitePanel } from '../SitePanel';
import type { WebsiteDocument } from '../types';

it('links to the font upload in the branding settings', () => {
  const doc = { version: 1, pages: [], theme: { headingFont: null, bodyFont: null, buttonStyle: null, accent: null, background: null, text: null }, customCss: '', footer: { columns: [], legal: 'column', copyright: '', background: 'default' }, menu: { layout: 'left', style: 'plain', sticky: true, transparent: false, mobile: 'dropdown', background: null, text: null, items: [] } } as WebsiteDocument;
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SitePanel doc={doc} update={() => {}} readOnly={false} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByRole('link', { name: /Manage fonts/ })).toHaveAttribute('href', '/admin/settings?tab=branding#fonts');
});
