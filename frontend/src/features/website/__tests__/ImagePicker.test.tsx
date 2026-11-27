/**
 * The picker's gallery list (issue 2618): a gallery with a password can be
 * put on the website, and the picker says what that publishes.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../services/website.service', () => ({
  websiteService: {
    listGalleries: vi.fn().mockResolvedValue([
      { id: 1, name: 'Private wedding', slug: 'w', date: null, showOnWebsite: true, eligible: true, hasPassword: true, reason: null, canChange: true },
      { id: 2, name: 'Open portraits', slug: 'p', date: null, showOnWebsite: true, eligible: true, hasPassword: false, reason: null, canChange: true },
    ]),
    setGalleryOnWebsite: vi.fn(),
  },
  mediaKey: (r: { source: string; id: string | number }) => `${r.source}:${r.id}`,
}));

import { GalleriesPane } from '../ImagePicker';

describe('GalleriesPane', () => {
  it('lets a protected gallery be picked from and says what becomes public', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GalleriesPane onOpen={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Private wedding' })).toBeInTheDocument();
    const notes = screen.getAllByText('Has a password. On the website, the photos you pick are public; the rest of the gallery keeps its password.');
    expect(notes).toHaveLength(1);
    expect(screen.getByText(/makes the photos you pick public, even when the gallery has a password/)).toBeInTheDocument();
  });
});
