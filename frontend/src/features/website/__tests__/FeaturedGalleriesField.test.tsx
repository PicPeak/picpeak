/**
 * The featured-galleries selector (issue 2618) lists galleries on the website
 * page by page, searchable, and always shows the chosen ones, however old.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { FeaturedGalleriesBlock, WebsiteGallery } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: vi.fn(() => true) }));
vi.mock('../../../services/website.service', () => ({
  websiteService: { listGalleries: vi.fn(), listPackages: vi.fn(), getBooking: vi.fn() },
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
    vi.mocked(websiteService.listPackages).mockResolvedValue({ available: true, packages: [{ id: 3, name: 'Full day', description: '' }] });
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3, 99], showPrices: true, buttonLabel: '', buttonTarget: null };
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
      { id: 3, name: 'Full day', description: '', unavailable: 'archived_items' },
      { id: 4, name: 'Half day', description: '', unavailable: 'archived_items' },
    ] });
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3], showPrices: true, buttonLabel: '', buttonTarget: null };
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
      .mockResolvedValue({ available: true, packages: [{ id: 3, name: 'Full day', description: '' }] });
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3], showPrices: true, buttonLabel: '', buttonTarget: null };
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
    const block = { id: 'p', type: 'pricing' as const, variant: 'cards', background: 'default' as const, heading: '', intro: '', packageIds: [3], showPrices: true, buttonLabel: '', buttonTarget: null };
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

  it('several galleries without a password get one warning that names them, not one each', async () => {
    vi.mocked(websiteService.listGalleries).mockReset();
    vi.mocked(websiteService.listGalleries).mockImplementation(async (params = {}) => (params.ids
      ? { galleries: [g(5, 'Open party'), g(6, 'Open day'), { ...g(7, 'Private wedding'), hasPassword: true }], hasMore: false }
      : { galleries: [], hasMore: false }));
    const block: FeaturedGalleriesBlock = { id: 'f', type: 'featuredGalleries', variant: 'cards', background: 'default', heading: '', intro: '', galleries: [{ id: 5, text: '' }, { id: 6, text: '' }, { id: 7, text: '' }] };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={vi.fn()} /></QueryClientProvider>);
    await screen.findByLabelText('Open party');
    expect(screen.getAllByText(/no password/)).toHaveLength(1);
    expect(screen.getByText(/have no password: their cards link to them/)).toBeInTheDocument();
  });

  it('puts the search above the whole list, not between the chosen galleries and the rest', async () => {
    vi.mocked(websiteService.listGalleries).mockReset();
    vi.mocked(websiteService.listGalleries).mockImplementation(async (params = {}) => (params.ids
      ? { galleries: [g(5, 'Chosen one')], hasMore: false }
      : { galleries: [g(8, 'Another')], hasMore: false }));
    const block: FeaturedGalleriesBlock = { id: 'f', type: 'featuredGalleries', variant: 'cards', background: 'default', heading: '', intro: '', galleries: [{ id: 5, text: '' }] };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={vi.fn()} /></QueryClientProvider>);
    const chosen = await screen.findByLabelText('Chosen one');
    const search = screen.getByRole('searchbox');
    expect(search.compareDocumentPosition(chosen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers no picture for a minimal hero, and says so', () => {
    const hero = { id: 'h', type: 'hero' as const, variant: 'minimal', background: 'default' as const, heading: 'Hi', subheading: '', buttonLabel: '', buttonTarget: null, image: null, video: null };
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={hero} onChange={vi.fn()} /></QueryClientProvider>);
    expect(screen.queryByText('Image')).toBeNull();
    expect(screen.getByText(/style shows no picture or video/)).toBeInTheDocument();
    unmount();
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={{ ...hero, variant: 'overlay' }} onChange={vi.fn()} /></QueryClientProvider>);
    expect(screen.getByText('Image')).toBeInTheDocument();
  });

  it('unchecking the last chosen gallery unchecks it', async () => {
    vi.mocked(websiteService.listGalleries).mockReset();
    vi.mocked(websiteService.listGalleries).mockImplementation(async (params = {}) => (params.ids
      ? { galleries: [g(5, 'Only one')], hasMore: false }
      : { galleries: [g(5, 'Only one')], hasMore: false }));
    const Holder = () => {
      const [block, setBlock] = React.useState<FeaturedGalleriesBlock>({ id: 'f', type: 'featuredGalleries', variant: 'cards', background: 'default', heading: '', intro: '', galleries: [{ id: 5, text: '' }] });
      return <BlockEditor block={block} onChange={(next) => setBlock(next as FeaturedGalleriesBlock)} />;
    };
    render(<QueryClientProvider client={new QueryClient()}><Holder /></QueryClientProvider>);
    const box = await screen.findByLabelText('Only one');
    await waitFor(() => expect(box).toBeChecked());
    fireEvent.click(box);
    await waitFor(() => expect(screen.getAllByLabelText('Only one').every((el) => !(el as HTMLInputElement).checked)).toBe(true));
  });

  it('a custom background offers the branding colours and a picker; the text colour is automatic until set', () => {
    const onChange = vi.fn();
    const text = { id: 't', type: 'text' as const, variant: 'left', background: 'custom' as const, backgroundColor: '#1e3a2f', textColor: null, heading: '', body: '' };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={text} onChange={onChange} brandColors={['#6f8466', '#f7f4ef']} /></QueryClientProvider>);
    // The swatches: the branding's colours first (this t() does not interpolate).
    fireEvent.click(screen.getAllByRole('button', { name: /^Use colour/ })[0]);
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ background: 'custom', backgroundColor: '#6f8466' });
    expect(screen.getByLabelText('Background colour')).toHaveValue('#1e3a2f');
    expect(screen.getByText('Automatic, for contrast')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Text colour'), { target: { value: '#ffcc00' } });
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ textColor: '#ffcc00' });
  });

  it('the branding colours and the neutrals each have a row, so no swatch is left alone on a line', () => {
    const text = { id: 't', type: 'text' as const, variant: 'left', background: 'custom' as const, backgroundColor: '#1e3a2f', textColor: null, heading: '', body: '' };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={text} onChange={vi.fn()} brandColors={['#6f8466', '#f7f4ef', '#ffffff']} /></QueryClientProvider>);
    const rows = screen.getAllByRole('group', { name: /colours$/ });
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll('button')).toHaveLength(3);
    // A neutral the branding already has is not offered twice.
    expect(rows[1].querySelectorAll('button')).toHaveLength(4);
  });

  it('switching to a custom background starts from a colour', () => {
    const onChange = vi.fn();
    const text = { id: 't', type: 'text' as const, variant: 'left', background: 'default' as const, heading: '', body: '' };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={text} onChange={onChange} brandColors={['#6f8466']} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ background: 'custom', backgroundColor: '#6f8466', textColor: null });
  });

  it('a divider sets its width and spacing', () => {
    const onChange = vi.fn();
    const divider = { id: 'd', type: 'divider' as const, variant: 'thin', background: 'default' as const, width: 'full' as const, spacing: 'medium' as const };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={divider} onChange={onChange} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Short' }));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ width: 'short' });
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ spacing: 'none' });
  });

  it('the text block is edited with the rich text editor; two columns get a left and a right one', async () => {
    const onChange = vi.fn();
    const text = { id: 't', type: 'text' as const, variant: 'columns', background: 'default' as const, heading: '', body: '<p>Left text</p>', bodyRight: '' };
    render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={text} onChange={onChange} /></QueryClientProvider>);
    expect(await screen.findByText('Left column')).toBeInTheDocument();
    expect(screen.getByText('Right column')).toBeInTheDocument();
    expect(screen.getAllByTitle(/Heading 2/)).toHaveLength(2);
    expect(screen.getByText('Left text')).toBeInTheDocument();
    expect(screen.getByText(/flows over both columns/)).toBeInTheDocument();
  });

  it('the booking block says where it leads, links the booking page and its settings, and can name a service', async () => {
    vi.mocked(websiteService.getBooking).mockResolvedValue({ flagOn: true, services: [{ id: 4, name: 'Portraits' }] });
    const onChange = vi.fn();
    const block = { id: 'b', type: 'booking' as const, variant: 'button', background: 'default' as const, heading: '', text: '', buttonLabel: '', serviceId: null };
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><BlockEditor block={block} onChange={onChange} /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(/Opens your booking page/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the booking page/ })).toHaveAttribute('href', '/book');
    expect(screen.getByRole('link', { name: /Booking settings/ })).toHaveAttribute('href', '/admin/clients/bookings');
    fireEvent.change(await screen.findByLabelText('Service'), { target: { value: '4' } });
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ serviceId: 4 });
  });

  it('says why the booking block is hidden: booking off, or nothing bookable', async () => {
    vi.mocked(websiteService.getBooking).mockResolvedValue({ flagOn: true, services: [] });
    const block = { id: 'b', type: 'booking' as const, variant: 'button', background: 'default' as const, heading: '', text: '', buttonLabel: '', serviceId: null };
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><BlockEditor block={block} onChange={vi.fn()} /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(/Nothing can be booked yet/)).toBeInTheDocument();
    unmount();
    vi.mocked(websiteService.getBooking).mockResolvedValue({ flagOn: false, services: [] });
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><BlockEditor block={block} onChange={vi.fn()} /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(/Client booking is switched off/)).toBeInTheDocument();
  });
});

