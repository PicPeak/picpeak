/**
 * The featured-galleries selector (issue 2618) lists galleries on the website
 * page by page, searchable, and always shows the chosen ones, however old.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeaturedGalleriesBlock, WebsiteGallery } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: vi.fn(() => true) }));
vi.mock('../../../services/website.service', () => ({
  websiteService: { listGalleries: vi.fn(), listPackages: vi.fn() },
  mediaKey: (r: { source: string; id: string | number }) => `${r.source}:${r.id}`,
}));

import { websiteService } from '../../../services/website.service';
import { usePermission } from '../../../hooks/usePermission';
import { BlockEditor } from '../BlockEditor';

const g = (id: number, name: string): WebsiteGallery => ({ id, name, slug: `g${id}`, date: null, showOnWebsite: true, eligible: true, hasPassword: false, reason: null, canChange: true });

describe('featured galleries selector', () => {
  it('shows the chosen gallery, pages the rest and searches them', async () => {
    vi.mocked(websiteService.listGalleries).mockImplementation(async (params = {}) => {
      if (params.ids) return { galleries: [g(99, 'Chosen long ago')], hasMore: false };
      expect(params.onWebsite).toBe(true);
      if (params.q) return { galleries: [g(7, 'Winter match')], hasMore: false };
      return params.page === 2 ? { galleries: [g(2, 'Second page')], hasMore: false } : { galleries: [g(1, 'First page')], hasMore: true };
    });
    const block: FeaturedGalleriesBlock = { id: 'f', type: 'featuredGalleries', variant: 'cards', background: 'default', heading: '', intro: '', galleries: [{ id: 99, text: '' }] };
    const onChange = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={onChange} /></QueryClientProvider>);
    expect(await screen.findByLabelText('Chosen long ago')).toBeChecked();
    expect(await screen.findByLabelText('First page')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByLabelText('Second page')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'winter' } });
    fireEvent.click(await screen.findByLabelText('Winter match'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0].galleries).toEqual([{ id: 99, text: '' }, { id: 7, text: '' }]);
  });
});

describe('chosen entries that are gone', () => {
  it('lists a deleted or archived gallery as unavailable and lets it be removed', async () => {
    vi.mocked(websiteService.listGalleries).mockImplementation(async (params = {}) => (params.ids
      ? { galleries: [g(99, 'Still here')], hasMore: false }
      : { galleries: [], hasMore: false }));
    const block: FeaturedGalleriesBlock = { id: 'f', type: 'featuredGalleries', variant: 'cards', background: 'default', heading: '', intro: '', galleries: [{ id: 99, text: '' }, { id: 55, text: '' }] };
    const onChange = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={onChange} /></QueryClientProvider>);
    expect(await screen.findByText('Gallery no longer available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the unavailable gallery' }));
    expect(onChange.mock.calls[0][0].galleries).toEqual([{ id: 99, text: '' }]);
  });

  it('lists an archived package as unavailable, also while quotes are off, and lets it be removed', async () => {
    vi.mocked(websiteService.listPackages).mockResolvedValue({ available: true, packages: [{ id: 3, name: 'Full day', description: '', currency: 'CHF' }] });
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3, 99], showPrices: true, buttonLabel: '', buttonUrl: '' };
    const onChange = vi.fn();
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={onChange} /></QueryClientProvider>);
    expect(await screen.findByText('Package no longer in the catalogue')).toBeInTheDocument();
    expect(screen.getByLabelText('Full day')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the unavailable package' }));
    expect(onChange.mock.calls[0][0].packageIds).toEqual([3]);
    unmount();

    vi.mocked(websiteService.listPackages).mockResolvedValue({ available: false, packages: [] });
    onChange.mockClear();
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={{ ...block, packageIds: [3] }} onChange={onChange} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the unavailable package' }));
    expect(onChange.mock.calls[0][0].packageIds).toEqual([]);
  });

  it('marks a package with an archived item as not shown, keeps it removable and not newly pickable', async () => {
    vi.mocked(websiteService.listPackages).mockResolvedValue({ available: true, packages: [
      { id: 3, name: 'Full day', description: '', currency: 'CHF', unavailable: 'archived_items' },
      { id: 4, name: 'Half day', description: '', currency: 'CHF', unavailable: 'archived_items' },
    ] });
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3], showPrices: true, buttonLabel: '', buttonUrl: '' };
    const onChange = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={onChange} /></QueryClientProvider>);
    expect(await screen.findAllByText('Contains archived items, not shown')).toHaveLength(2);
    expect(screen.getByLabelText(/Full day/)).toBeChecked();
    expect(screen.getByLabelText(/Half day/)).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Full day/));
    expect(onChange.mock.calls[0][0].packageIds).toEqual([]);
  });

  it('says the galleries could not load instead of "none on the website", and retries', async () => {
    vi.mocked(websiteService.listGalleries).mockReset();
    vi.mocked(websiteService.listGalleries)
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValue({ galleries: [g(1, 'First page')], hasMore: false });
    const block: FeaturedGalleriesBlock = { id: 'f', type: 'featuredGalleries', variant: 'cards', background: 'default', heading: '', intro: '', galleries: [] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><BlockEditor block={block} onChange={vi.fn()} /></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/No gallery is on the website yet/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('First page')).toBeInTheDocument();
  });

  it('says the catalogue could not load instead of calling chosen packages unavailable, and retries', async () => {
    vi.mocked(websiteService.listPackages).mockReset();
    vi.mocked(websiteService.listPackages)
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValue({ available: true, packages: [{ id: 3, name: 'Full day', description: '', currency: 'CHF' }] });
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3], showPrices: true, buttonLabel: '', buttonUrl: '' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><BlockEditor block={block} onChange={vi.fn()} /></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Package no longer in the catalogue')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Full day')).toBeChecked();
    expect(screen.queryByText('Package no longer in the catalogue')).toBeNull();
  });

  it('without the permission to view quotes it says so, and calls no chosen package unavailable', async () => {
    vi.mocked(usePermission).mockImplementation((p: string) => p !== 'quotes.view');
    vi.mocked(websiteService.listPackages).mockClear();
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3], showPrices: true, buttonLabel: '', buttonUrl: '' };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={vi.fn()} /></QueryClientProvider>);
    expect(await screen.findByText(/needs the permission to view quotes/)).toBeInTheDocument();
    expect(screen.queryByText('Package no longer in the catalogue')).toBeNull();
    expect(websiteService.listPackages).not.toHaveBeenCalled();
    vi.mocked(usePermission).mockImplementation(() => true);
  });

  it('warns that featuring a gallery without a password opens all of it', async () => {
    vi.mocked(websiteService.listGalleries).mockReset();
    vi.mocked(websiteService.listGalleries).mockImplementation(async (params = {}) => (params.ids
      ? { galleries: [{ ...g(5, 'Open party'), hasPassword: false }, { ...g(6, 'Private wedding'), hasPassword: true }], hasMore: false }
      : { galleries: [], hasMore: false }));
    const block: FeaturedGalleriesBlock = { id: 'f', type: 'featuredGalleries', variant: 'cards', background: 'default', heading: '', intro: '', galleries: [{ id: 5, text: '' }, { id: 6, text: '' }] };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={vi.fn()} /></QueryClientProvider>);
    await screen.findByLabelText('Open party');
    // One note, for the gallery without a password (the test's t() does not interpolate).
    expect(screen.getAllByText(/has no password: its card links to it/)).toHaveLength(1);
  });

  it('offers no picture for a minimal hero, and says so', () => {
    const hero = { id: 'h', type: 'hero' as const, variant: 'minimal', background: 'default' as const, heading: 'Hi', subheading: '', buttonLabel: '', buttonUrl: '', image: null, video: null };
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={hero} onChange={vi.fn()} /></QueryClientProvider>);
    expect(screen.queryByText('Image')).toBeNull();
    expect(screen.getByText(/style shows no picture or video/)).toBeInTheDocument();
    unmount();
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={{ ...hero, variant: 'overlay' }} onChange={vi.fn()} /></QueryClientProvider>);
    expect(screen.getByText('Image')).toBeInTheDocument();
  });
});

