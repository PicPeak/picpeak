import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { GalleryPrintShop, PrintSalesProvider, PrintShopEntry } from '../GalleryPrintShop';
import { PrintSalesAdminPage } from '../AdminPage';
import { SpatialPreview } from '../SpatialPreview';
import { usePrintSales } from '../PrintSalesContext';
import { centredCrop } from '../CropEditor';
import { formatCm } from '../shopping';
import { ProfileEditor } from '../ProfileEditor';
import { api } from '../../../config/api';
import type { Photo } from '../../../types';
import type { Order, Quote, Variant, Profile } from '../model';
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = renderUi(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...result, rerender: (next: ReactElement) => result.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) };
}
const permissions = vi.hoisted(() => ({ enabled: true, manage: true, denied: new Set<string>() }));
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (_key: string, fallback: string | { defaultValue: string }) => typeof fallback === 'string' ? fallback : fallback.defaultValue }) }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission: (p: string) => !permissions.denied.has(p) && (permissions.manage || !['products.manage', 'products.configure', 'bills.manage', 'customers.edit'].includes(p)) }) }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: () => permissions.enabled }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: (date: string) => `formatted ${date}` }) }));
vi.mock('../../../components/common/AuthenticatedImage', () => ({ AuthenticatedImage: ({ onLoad, onUnavailable, isGallery: _gallery, slug: _slug, ...props }: any) =>
  <img {...props} onError={() => onUnavailable?.(true)} onLoad={() => onLoad?.(props.src?.includes('landscape') ? { width: 800, height: 400 } : { width: 400, height: 600 })} /> }));
vi.mock('../../../components/admin/SettingsSaveBar', () => ({ SettingsSaveBar: ({ onSave, isDirty }: any) => <button disabled={!isDirty} onClick={onSave}>Save print settings</button> }));
vi.mock('../../../config/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), head: vi.fn(), getUri: ({ url }: { url: string }) => `/api${url}` } }));
const photo = { id: 1, filename: 'sample.jpg', original_filename: 'camera.jpg', url: '/synthetic.jpg', width: 400, height: 600 } as Photo;
const variant: Variant = { id: 'profile-1', version: 'profile-version', selection: { schemaVersion: 2, productVersion: 'product-version', product: { id: 'product-1', name: 'Photographic print' },
  attributes: [{ id: 'size', name: 'Size', addOn: false, options: [{ id: 'small', name: '10 × 15 cm', imageId: null }] }] },
artwork: { widthMm: 100, heightMm: 150 }, fitModes: ['cover', 'contain'], currency: 'EUR', unitPriceMinor: 250 };
const quotation: Quote = { expiresAt: new Date(Date.now() + 30 * 60e3).toISOString(), id: 'order-1', status: 'quoted', renderStatus: 'ready', preparation: { stage: 'ready', completed: 4, total: 4, percent: 100 }, invoiceId: null,
  snapshotHash: 'frozen-selection-hash', artworkVersion: null, currency: 'EUR', totalMinor: 615, netMinor: 500, vatMinor: 115,
  policy: 'Synthetic buyer policy', acceptedAt: null, reviewedAt: null, submittedAt: null, dispatchedAt: null,
  supplierReference: null, tracking: null, needsAttention: false, purgedAt: null,
  items: [{ profileId: variant.id, photoId: 1, filename: 'camera.jpg', quantity: 2, crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'cover', selection: variant.selection, unitPriceMinor: 250 }] };
beforeEach(() => {
  sessionStorage.clear(); permissions.enabled = true; permissions.manage = true; permissions.denied.clear();
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.endsWith('/orders') ? { orders: [] } : url.includes('/orders/') ? quotation : { variants: [variant], countries: ['IE'], policy: 'Synthetic buyer policy', basketScope: 'buyer-1' } }) as any);
  vi.mocked(api.post).mockImplementation(async (url: string) => ({ data: url.endsWith('/accept') ? { ...quotation, status: 'accepted', acceptedAt: '2026-10-28', invoiceId: 42 } : quotation }) as any);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
async function addItem() {
  fireEvent.click(await screen.findByRole('button', { name: 'Choose prints' }));
  fireEvent.click(screen.getByRole('button', { name: /camera.jpg/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose print options (1)' }));
  fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
  fireEvent.click(screen.getByRole('button', { name: 'Add to basket' }));
}
describe('gallery print order journey', () => {
  it('reviews the server total and requires explicit selection acknowledgement before acceptance', async () => {
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
    fireEvent.change(screen.getByLabelText('Copies: camera.jpg'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review selections and final total' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm order and request invoice' });
    expect(confirm).toBeDisabled(); expect(screen.getByText('Synthetic buyer policy')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(confirm);
    await screen.findByText(/Invoice.*#42/);
    const [url, input] = vi.mocked(api.post).mock.calls[1];
    expect(url).toBe('/gallery/fixture/print-sales/orders/order-1/accept');
    expect(input).toEqual({ snapshotHash: quotation.snapshotHash, acknowledgeSelection: true });
  });
  it('asks for a new quotation after a refused acceptance instead of replaying the dead one', async () => {
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
    fireEvent.click(screen.getByRole('button', { name: 'Review selections and final total' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm order and request invoice' });
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { error: 'The quotation expired; review a new quotation' } } });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(confirm);
    await screen.findByText(/quotation expired/);
    fireEvent.click(screen.getByRole('button', { name: 'Return to basket' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review selections and final total' }));
    await screen.findByRole('button', { name: 'Confirm order and request invoice' });
    const reviews = vi.mocked(api.post).mock.calls.filter(([url]) => url.endsWith('/quotes')) as [string, { requestId: string }][];
    expect(reviews).toHaveLength(2); expect(reviews[1][1].requestId).not.toBe(reviews[0][1].requestId);
  });
  it('edits a basket crop without duplicating its photo item', async () => {
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
    fireEvent.click(screen.getByRole('button', { name: 'Edit crop' }));
    fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    fireEvent.change(screen.getByLabelText('Crop zoom'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update basket item' }));
    await waitFor(() => {
      const basket = JSON.parse(sessionStorage.getItem('print-basket:buyer-1') || '[]');
      expect(basket).toHaveLength(1); expect(basket[0].crop.width).toBe(.5);
    });
  });
  it('keeps a stable request ID across quotation network retries and sends no client price or buyer ID', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Temporary network failure')).mockResolvedValueOnce({ data: quotation });
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
    const review = screen.getByRole('button', { name: 'Review selections and final total' });
    fireEvent.click(review); await screen.findByText('Temporary network failure'); fireEvent.click(review);
    await screen.findByRole('button', { name: 'Confirm order and request invoice' });
    const a = vi.mocked(api.post).mock.calls[0][1] as any, b = vi.mocked(api.post).mock.calls[1][1] as any;
    expect(a.requestId).toBe(b.requestId); expect(Object.keys(a).sort()).toEqual(['delivery', 'items', 'requestId']);
    expect(Object.keys(a.items[0]).sort()).toEqual(['crop', 'fit', 'photoId', 'profileId', 'quantity']);
  });
  it('isolates stored baskets between buyer scopes', async () => {
    sessionStorage.setItem('print-basket:another-buyer', JSON.stringify([{ photoId: 999 }]));
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />);
    await screen.findByRole('button', { name: 'Choose prints' });
    expect(screen.queryByText('Your basket')).not.toBeInTheDocument();
  });
  it('quietly withdraws a disabled shop', async () => {
    vi.mocked(api.get).mockRejectedValue({ response: { status: 403 } });
    const { container } = render(<GalleryPrintShop slug="fixture" photos={[photo]} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled()); expect(container).toBeEmptyDOMElement();
  });
  it('retains the source crop and copies when selecting more, and centres each new photograph independently', async () => {
    const second = { ...photo, id: 2, filename: 'second.jpg', original_filename: 'second.jpg', url: '/landscape.jpg' };
    render(<GalleryPrintShop slug="fixture" photos={[photo, second]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose prints' }));
    fireEvent.click(screen.getByRole('button', { name: /camera.jpg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose print options (1)' }));
    fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    fireEvent.change(screen.getByLabelText('Crop zoom'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Copies for this photograph'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select more photographs' }));
    fireEvent.click(screen.getByRole('button', { name: /second.jpg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose print options (2)' }));
    fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    expect(screen.getByLabelText('Crop zoom')).toHaveValue('2');
    expect(screen.getByLabelText('Copies for this photograph')).toHaveValue(3);
    expect(screen.getByRole('button', { name: 'Add to basket (2)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'second.jpg' }));
    fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    expect(screen.getByLabelText('Crop zoom')).toHaveValue('1');
    fireEvent.click(screen.getByRole('button', { name: 'Add to basket (2)' }));
    await waitFor(() => {
      const lines = JSON.parse(sessionStorage.getItem('print-basket:buyer-1') || '[]');
      expect(lines).toHaveLength(2); expect(lines.map((i: any) => i.quantity)).toEqual([3, 3]);
      expect(lines[0].crop).toEqual({ x: .25, y: .25, width: .5, height: .5 });
      expect(lines[1].crop.width).toBeCloseTo(1 / 3); expect(lines[1].crop.height).toBe(1);
    });
  });
  it('retains selections across searches and beyond the first page', async () => {
    const photos = Array.from({ length: 30 }, (_, n) => ({ ...photo, id: n + 1, original_filename: `image-${n + 1}.jpg` }));
    render(<GalleryPrintShop slug="fixture" photos={photos} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose prints' }));
    fireEvent.click(screen.getByRole('button', { name: /image-1.jpg/ }));
    fireEvent.change(screen.getByLabelText('Find a photograph'), { target: { value: 'image-30' } });
    fireEvent.click(screen.getByRole('button', { name: /image-30.jpg/ }));
    fireEvent.change(screen.getByLabelText('Find a photograph'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: /image-1.jpg/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Choose print options (2)' }));
    expect(screen.getByRole('button', { name: 'image-1.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'image-30.jpg' })).toBeInTheDocument();
  });
  it('never persists an invalid quantity and prevents a quotation while it is invalid', async () => {
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
    const input = screen.getByLabelText('Copies: camera.jpg');
    for (const value of ['', '0', '101', '1.5']) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole('button', { name: 'Review selections and final total' })).toBeDisabled();
      expect(JSON.parse(sessionStorage.getItem('print-basket:buyer-1')!)[0].quantity).toBe(1);
    }
    fireEvent.blur(input);
    expect(input).toHaveValue(1); expect(screen.getByRole('button', { name: 'Review selections and final total' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'More copies: Copies: camera.jpg' }));
    expect(input).toHaveValue(2);
  });
  it('keeps a ready preview when clicking the active photo and clears invalid text when switching photos', async () => {
    const second = { ...photo, id: 2, original_filename: 'second.jpg', url: '/second.jpg' };
    render(<GalleryPrintShop slug="fixture" photos={[photo, second]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose prints' }));
    fireEvent.click(screen.getByRole('button', { name: /camera.jpg/ })); fireEvent.click(screen.getByRole('button', { name: /second.jpg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose print options (2)' })); fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    fireEvent.click(screen.getByRole('button', { name: 'second.jpg' })); fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    const add = screen.getByRole('button', { name: 'Add to basket (2)' }); expect(add).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'second.jpg' })); expect(add).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Copies for this photograph'), { target: { value: '0' } }); expect(add).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'camera.jpg' })); fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    expect(screen.getByLabelText('Copies for this photograph')).toHaveValue(1); expect(add).toBeEnabled();
  });
  it('holds adding until the preview loads and withdraws it when the preview fails', async () => {
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose prints' }));
    fireEvent.click(screen.getByRole('button', { name: /camera.jpg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose print options (1)' }));
    const add = screen.getByRole('button', { name: 'Add to basket' }), image = screen.getByAltText('Selected photograph and print crop');
    expect(add).toBeDisabled(); fireEvent.load(image); expect(add).toBeEnabled(); fireEvent.error(image); expect(add).toBeDisabled();
  });
  it('uses finished trim dimensions for spatial scale without modifying the crop', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.endsWith('/orders') ? { orders: [] } : url.includes('/orders/') ? quotation : { variants: [{ ...variant, trimMm: { width: 100, height: 150 }, bleedMm: { left: 5, top: 5, right: 5, bottom: 5 }, artwork: { widthMm: 110, heightMm: 160 } }], countries: ['IE'], basketScope: 'buyer-1' } }) as any);
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose prints' })); fireEvent.click(screen.getByRole('button', { name: /camera.jpg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose print options (1)' })); fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    fireEvent.change(screen.getByLabelText('Crop zoom'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'See it in a space' }));
    expect(screen.getByTestId('spatial-print').style.width).toBe(`${100 / 1200 * 100}%`);
    expect(parseFloat((screen.getByTestId('spatial-print').firstElementChild as HTMLElement).style.width)).toBeCloseTo(110);
    expect(parseFloat((screen.getByTestId('spatial-print').firstElementChild as HTMLElement).style.top)).toBeCloseTo(-5 / 150 * 100);
    fireEvent.click(screen.getByRole('button', { name: 'On a wall' }));
    expect(screen.getByTestId('spatial-print').style.width).toBe(`${100 / 3000 * 100}%`);
    expect(screen.getByLabelText('Crop zoom')).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Add to basket' }));
    expect(JSON.parse(sessionStorage.getItem('print-basket:buyer-1')!)[0].crop.width).toBe(.5);
  });
  it('does not shrink oversized art to fit a desk or invent trim dimensions for an older offer', () => {
    const props = { slug: 'fixture', src: '/sample.jpg', crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'cover' };
    const { rerender, container } = render(<SpatialPreview {...props} variant={variant} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SpatialPreview {...props} variant={{ ...variant, trimMm: { width: 900, height: 1200 } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'See it in a space' }));
    expect(screen.getByTestId('spatial-print')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'On a desk' }));
    expect(screen.queryByTestId('spatial-print')).not.toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent('does not fit');
  });
  it('never silently drops an oversized gallery selection and performs no requests when unavailable', async () => {
    const photos = Array.from({ length: 21 }, (_, n) => ({ ...photo, id: n + 1, original_filename: `image-${n + 1}.jpg` }));
    const { rerender } = render(<PrintSalesProvider slug="fixture" enabled={false} photos={photos}><PrintShopEntry /></PrintSalesProvider>);
    expect(api.get).not.toHaveBeenCalled();
    rerender(<PrintSalesProvider slug="fixture" photos={photos} selectedPhotoIds={new Set(photos.map(p => p.id))}><PrintShopEntry /></PrintSalesProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose prints' }));
    expect(screen.getByRole('button', { name: 'Choose print options (21)' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Deselect');
    fireEvent.click(screen.getByRole('button', { name: /image-1.jpg/ }));
    expect(screen.getByRole('button', { name: 'Choose print options (20)' })).toBeEnabled();
  });
  it('starts directly on a viewed photograph and retains its draft on closing and reopening', async () => {
    function Opener() { const shop = usePrintSales(); return <button disabled={!shop?.available} onClick={() => shop?.openPhoto(1)}>Print viewed photo</button>; }
    render(<PrintSalesProvider slug="fixture" photos={[photo]}><Opener /></PrintSalesProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Print viewed photo' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Print viewed photo' })); fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    fireEvent.change(screen.getByLabelText('Crop zoom'), { target: { value: '2' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Print viewed photo' })); fireEvent.load(screen.getByAltText('Selected photograph and print crop'));
    expect(screen.getByLabelText('Crop zoom')).toHaveValue('2');
  });
  it('derives an aspect-correct centred crop and bounded zoom', () => {
    expect(centredCrop(2, 1)).toEqual({ x: .25, y: 0, width: .5, height: 1 });
    expect(centredCrop(.5, 1, 2)).toEqual({ x: .25, y: .375, width: .5, height: .25 });
  });
});
describe('print administration', () => {
  it('observes the actual browser download without buffering the archive', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/downloads/') ? { id: 'download-1', status: 'complete' } : url.includes('/orders') ? { orders: [{ ...quotation, status: 'accepted', acceptedAt: '2026-11-01', renderStatus: 'ready', invoiceId: 42 }] } :
      { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } }) as any);
    vi.mocked(api.post).mockResolvedValue({ data: { id: 'download-1', status: 'pending' } } as any);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Supplier pack' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    await screen.findByText('File sent. Check your browser downloads.');
    expect(api.post).toHaveBeenCalledWith('/admin/print-sales/orders/order-1/files/pack/downloads', {}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.head).not.toHaveBeenCalled();
    expect(vi.mocked(api.get).mock.calls.some(([, config]) => config?.responseType === 'blob')).toBe(false);
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Payment is not settled'));
    fireEvent.click(screen.getByRole('button', { name: 'Supplier pack' }));
    await screen.findByText('Payment is not settled');
    expect(click).toHaveBeenCalledTimes(1); click.mockRestore();
  });
  it.each(['A production file is missing', 'Two print file operations are already in progress; try again shortly'])('reports a native GET failure: %s', async error => {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/downloads/') ? { id: 'download-1', status: 'failed', error } : url.includes('/orders') ? { orders: [{ ...quotation, status: 'accepted', acceptedAt: '2026-11-01', renderStatus: 'ready', invoiceId: 42 }] } :
      { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } }) as any);
    vi.mocked(api.post).mockResolvedValue({ data: { id: 'download-1', status: 'pending' } } as any);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Supplier pack' }));
    await screen.findByText(error);
    expect(screen.getByRole('alert').closest('details')).not.toBeNull();
    expect(click).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Supplier pack' })).toBeEnabled();
    click.mockRestore();
  });
  it('distinguishes an unavailable status check from a known download failure', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/downloads/')) throw new Error('Network unavailable');
      return { data: url.includes('/orders') ? { orders: [{ ...quotation, status: 'accepted', acceptedAt: '2026-11-01', renderStatus: 'ready', invoiceId: 42 }] } :
        { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } } as any;
    });
    vi.mocked(api.post).mockResolvedValue({ data: { id: 'download-1', status: 'pending' } } as any);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Supplier pack' }));
    await screen.findByText('Download status could not be checked. Check your browser downloads before trying again.');
    expect(click).toHaveBeenCalledTimes(1); click.mockRestore();
  });

  it('keeps retained orders readable when new ordering is disabled', async () => {
    permissions.enabled = false;
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/orders') ? { orders: [{ ...quotation, status: 'accepted', acceptedAt: '2026-10-28', invoiceId: 42 }] } :
      { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } }) as any);
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    expect(await screen.findByText('Print ordering is disabled. Turn it on again to finish open orders.')).toBeInTheDocument();
    expect(await screen.findByText(/Open native invoice/)).toHaveAttribute('href', '/admin/clients/bills/42');
    expect(screen.queryByRole('button', { name: 'Save print settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Supplier pack' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close order manually' })).not.toBeInTheDocument();
  });
  it('keeps floating point out of the centimetre labels', () => {
    expect(formatCm(279.4)).toBe('27.9');
    expect(formatCm(100)).toBe('10');
  });
  it('keeps file-download permissions separate from fulfilment edits and explains read-only settings', async () => {
    permissions.denied.add('customers.edit'); permissions.denied.add('products.manage');
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/orders') ? { orders: [{ ...quotation, status: 'accepted', acceptedAt: '2026-10-28', invoiceId: 42, renderStatus: 'ready' }] } :
      { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } }) as any);
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    expect(await screen.findByText('You can view these print settings but cannot change them.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Supplier pack' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'I checked these production files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order after native invoice correction' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save print settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Buyer policy and delivery information')).toBeDisabled();
    expect(screen.getByText('Artwork ready')).toBeInTheDocument();
  });
  it('distinguishes an order-load failure from an empty list and offers a working retry', async () => {
    let attempts = 0;
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/orders') && !attempts++) throw new Error('Synthetic order load failure');
      return { data: url.includes('/orders') ? { orders: [] } : { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } } as any;
    });
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not load print orders');
    expect(screen.queryByText('No print orders yet')).not.toBeInTheDocument();
    fireEvent.click(within(failure).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No print orders yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('preserves unsaved configuration after a stale-settings rejection', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/orders') ? { orders: [] } :
      { revision: 3, profiles: [], countries: ['IE'], policy: 'Original policy', shippingPresetId: null, products: [], presets: [] } }) as any);
    vi.mocked(api.put).mockRejectedValue({ response: { data: { error: 'Print settings changed; reload before saving' } } });
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    const policy = await screen.findByLabelText('Buyer policy and delivery information');
    fireEvent.change(policy, { target: { value: 'Unsaved policy' } }); fireEvent.click(screen.getByRole('button', { name: 'Save print settings' }));
    await screen.findByText('Print settings changed; reload before saving'); expect(policy).toHaveValue('Unsaved policy');
  });
  it('saves studio delivery zones as CRM references without inventing another price list', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/orders') ? { orders: [] } :
      { revision: 4, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: 10, products: [],
        presets: [{ id: 10, name: 'Studio delivery item', currency: 'EUR', product_id: null }] } }) as any);
    vi.mocked(api.put).mockImplementation(async (_url: string, value: any) => ({ data: value }) as any);
    render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Delivery pricing'), { target: { value: 'zones' } });
    fireEvent.change(screen.getByLabelText('Zone name'), { target: { value: 'Our destinations' } });
    fireEvent.change(screen.getByLabelText('Delivery countries (two-letter codes, separated by commas)'), { target: { value: 'IE, DE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save print settings' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const sent = vi.mocked(api.put).mock.calls[0][1] as any;
    expect(sent.shippingPresetId).toBeNull();
    expect(sent.shippingZones[0]).toMatchObject({ name: 'Our destinations', countries: ['IE', 'DE'], cataloguePresetId: 10 });
    expect(sent.shippingZones[0]).not.toHaveProperty('price');
  });
  it('allows output, supplier instructions and photo-placement choices without selecting a named lab', () => {
    const initial: Profile = { cataloguePresetId: 0, definition: { id: 'profile', revision: 1, enabled: false, labReference: '',
      selection: { productId: '', productVersion: '', values: {} }, manufacturing: { capability: 'single-photo-rectangle',
        trimMm: { width: 100, height: 150 }, bleedMm: { top: 0, right: 0, bottom: 0, left: 0 }, safeInsetMm: { top: 0, right: 0, bottom: 0, left: 0 },
        resolution: { targetDpi: 300, minimumDpi: 150 }, output: { format: 'jpeg', colourSpace: 'srgb' }, fitModes: ['cover', 'contain'] } } };
    function Harness() {
      const [value, setValue] = useState(initial);
      return <><ProfileEditor value={value} products={[]} presets={[]} onChange={setValue} /><output data-testid="profile-json">{JSON.stringify(value)}</output></>;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('File format'), { target: { value: 'png' } });
    fireEvent.change(screen.getByLabelText('PNG compression (0–9)'), { target: { value: '9' } });
    expect(JSON.parse(screen.getByTestId('profile-json').textContent!).definition.manufacturing.output).toEqual({ format: 'png', colourSpace: 'srgb', compressionLevel: 9 });
    fireEvent.change(screen.getByLabelText('File format'), { target: { value: 'tiff' } });
    fireEvent.change(screen.getByLabelText('TIFF compression'), { target: { value: 'deflate' } });
    fireEvent.change(screen.getByLabelText('Supplier label (optional)'), { target: { value: 'Our production partner' } });
    fireEvent.change(screen.getByLabelText('Supplier preparation and ordering instructions'), { target: { value: 'Our stock code.\nOur packing instructions.' } });
    fireEvent.click(screen.getByLabelText('Fit whole photograph'));
    const result = JSON.parse(screen.getByTestId('profile-json').textContent!).definition;
    expect(result.manufacturing.output).toEqual({ format: 'tiff', colourSpace: 'srgb', compression: 'deflate' });
    expect(result.manufacturing.fitModes).toEqual(['cover']); expect(result.supplierName).toBe('Our production partner');
    expect(result.instructions).toContain('\nOur packing instructions.');
  });
  it('copies generic dimensions and trim allowances without changing catalogue choices or prices, and requires a fresh enable', async () => {
    const initial: Profile = { cataloguePresetId: 10, definition: { id: 'profile', revision: 1, enabled: true, labReference: 'Our stock',
      selection: { productId: '', productVersion: 'frozen-version', values: { finish: ['matte'] } }, manufacturing: { capability: 'single-photo-rectangle',
        trimMm: { width: 100, height: 150 }, bleedMm: { top: 1, right: 2, bottom: 3, left: 4 }, safeInsetMm: { top: 1, right: 2, bottom: 3, left: 4 },
        resolution: { targetDpi: 300, minimumDpi: 150 }, output: { format: 'jpeg', colourSpace: 'srgb' }, fitModes: ['cover', 'contain'] } } };
    function Harness() {
      const [value, setValue] = useState(initial);
      return <><ProfileEditor value={value} products={[]} presets={[]} onChange={setValue} /><output data-testid="profile-json">{JSON.stringify(value)}</output></>;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Start from a common size'), { target: { value: 'in-4-6' } });
    let p = JSON.parse(screen.getByTestId('profile-json').textContent!);
    expect(p.definition.manufacturing.trimMm).toEqual({ width: 101.6, height: 152.4 });
    expect(p.definition.enabled).toBe(false); expect(p.cataloguePresetId).toBe(10); expect(p.definition.selection).toEqual(initial.definition.selection);
    expect(p.definition.manufacturing.bleedMm).toEqual(initial.definition.manufacturing.bleedMm);
    fireEvent.change(screen.getByLabelText('Start from a common size'), { target: { value: 'cm-10-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap width and height' }));
    fireEvent.change(screen.getByLabelText('Added bleed on every edge'), { target: { value: '3.175' } });
    fireEvent.change(screen.getByLabelText('Safe inset inside every trim edge'), { target: { value: '6.35' } });
    fireEvent.change(screen.getByLabelText('Output colour profile'), { target: { value: 'adobe-rgb-1998' } });
    fireEvent.change(screen.getByLabelText('File format'), { target: { value: 'tiff' } });
    p = JSON.parse(screen.getByTestId('profile-json').textContent!);
    expect(p.definition.manufacturing.trimMm).toEqual({ width: 150, height: 100 });
    expect(p.definition.manufacturing.bleedMm).toEqual({ top: 3.175, right: 3.175, bottom: 3.175, left: 3.175 });
    expect(p.definition.manufacturing.safeInsetMm).toEqual({ top: 6.35, right: 6.35, bottom: 6.35, left: 6.35 });
    expect(p.definition.manufacturing.output.colourSpace).toBe('adobe-rgb-1998');
    fireEvent.change(screen.getByLabelText('Trim width (mm)'), { target: { value: '149,7' } });
    expect(JSON.parse(screen.getByTestId('profile-json').textContent!).definition.manufacturing.trimMm.width).toBe(149.7);
  });
});

describe('preparation before invoicing', () => {
  const pending: Quote = { ...quotation, status: 'capturing', renderStatus: 'running', artworkVersion: null,
    preparation: { stage: 'rendering', completed: 1, total: 4, percent: 25 } };
  function serve(status: () => Quote) {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.endsWith('/orders') ? { orders: [] } : url.includes('/orders/') ? status() :
      { variants: [variant], countries: ['IE'], policy: 'Synthetic buyer policy', basketScope: 'buyer-1' } }) as any);
  }
  it('shows real progress and only enables acknowledgement after the prepared files are ready', async () => {
    let current = pending; serve(() => current); vi.mocked(api.post).mockResolvedValue({ data: pending } as any);
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
    fireEvent.click(screen.getByRole('button', { name: 'Review selections and final total' }));
    const bar = await screen.findByRole('progressbar', { name: 'Print preparation progress' });
    expect(bar).toHaveAttribute('value', '25'); expect(bar).toHaveAttribute('aria-valuetext', expect.stringContaining('(1/4)'));
    expect(screen.getByText(/No invoice has been created/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm order and request invoice' })).toBeDisabled();
    current = quotation;
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled(), { timeout: 3500 });
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '100');
    expect(screen.getByRole('button', { name: 'Confirm order and request invoice' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Confirm order and request invoice' })).toBeEnabled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it('restores the opaque preparation ID after refresh and retries status without another quote', async () => {
    sessionStorage.setItem('print-preparation:buyer-1', pending.id);
    let unavailable = true;
    serve(() => { if (unavailable) throw new Error('offline'); return pending; });
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prints & orders (0)' }));
    const retry = await screen.findByRole('button', { name: 'Check progress again' });
    expect(screen.getByRole('button', { name: 'Confirm order and request invoice' })).toBeDisabled();
    unavailable = false; fireEvent.click(retry);
    await screen.findByRole('progressbar'); expect(api.post).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('print-preparation:buyer-1')).toBe(pending.id);
  });
  it('waits for discard before allowing edits, and preserves progress after a failed discard', async () => {
    serve(() => pending); vi.mocked(api.post).mockResolvedValueOnce({ data: pending } as any);
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
    fireEvent.click(screen.getByRole('button', { name: 'Review selections and final total' }));
    const back = await screen.findByRole('button', { name: 'Return to basket' });
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Could not discard'));
    fireEvent.click(back); await screen.findByText('Could not discard');
    expect(screen.queryByRole('button', { name: 'Edit crop' })).not.toBeInTheDocument();
    let finish!: (value: unknown) => void;
    vi.mocked(api.post).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as any);
    fireEvent.click(back); await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
    expect(back).toBeDisabled(); expect(screen.queryByRole('button', { name: 'Edit crop' })).not.toBeInTheDocument();
    finish({ data: { ...pending, status: 'expired' } });
    expect(await screen.findByRole('button', { name: 'Edit crop' })).toBeEnabled();
    expect(sessionStorage.getItem('print-preparation:buyer-1')).toBeNull();
    expect(vi.mocked(api.post).mock.calls[2][0]).toBe('/gallery/fixture/print-sales/orders/order-1/discard');
  });
  it('recovers an accepted order after a lost response without another invoice request', async () => {
    sessionStorage.setItem('print-preparation:buyer-1', quotation.id);
    sessionStorage.setItem('print-basket:buyer-1', JSON.stringify([{ ...quotation.items![0], lineId: 'line-1' }]));
    serve(() => ({ ...quotation, status: 'accepted', acceptedAt: '2026-11-01', invoiceId: 42 }));
    render(<GalleryPrintShop slug="fixture" photos={[photo]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prints & orders (1)' }));
    await screen.findByText(/Invoice.*#42/); expect(api.post).not.toHaveBeenCalled();
    await waitFor(() => expect(sessionStorage.getItem('print-basket:buyer-1')).toBe('[]'));
    expect(sessionStorage.getItem('print-preparation:buyer-1')).toBeNull();
  });
  it('aborts status requests on unmount to protect the next gallery session', async () => {
    sessionStorage.setItem('print-preparation:buyer-1', quotation.id);
    let signal: AbortSignal | undefined;
    const fallback = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((url: string, options?: any) => {
      if (url.includes('/orders/')) { signal = options.signal; return new Promise(() => {}); }
      return fallback(url, options);
    });
    const ui = render(<GalleryPrintShop slug="fixture" photos={[photo]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prints & orders (0)' }));
    await waitFor(() => expect(signal).toBeDefined()); ui.unmount(); expect(signal?.aborted).toBe(true);
  });
});

it('checks order status after a lost acceptance response and recovers the existing invoice', async () => {
  let confirmed = false;
  const fallback = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (url: string, options?: any) => url.includes('/orders/') ?
    { data: confirmed ? { ...quotation, status: 'accepted', acceptedAt: '2026-11-01', invoiceId: 42 } : quotation } as any : fallback(url, options));
  vi.mocked(api.post).mockImplementation(async (url: string) => {
    if (url.endsWith('/accept')) { confirmed = true; throw new Error('Connection lost'); }
    return { data: quotation } as any;
  });
  render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
  fireEvent.click(screen.getByRole('button', { name: 'Review selections and final total' }));
  const confirm = await screen.findByRole('button', { name: 'Confirm order and request invoice' });
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(confirm);
  await screen.findByText(/Invoice.*#42/);
  expect(vi.mocked(api.post).mock.calls.filter(([url]) => url.endsWith('/accept'))).toHaveLength(1);
  expect(screen.queryByText('Connection lost')).not.toBeInTheDocument();
});

it('shows the review deadline and disables confirmation when a ready quotation expires', async () => {
  let current = quotation;
  const fallback = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (url: string, options?: any) => url.includes('/orders/') ? { data: current } as any : fallback(url, options));
  vi.mocked(api.post).mockImplementation(async () => {
    current = { ...quotation, expiresAt: new Date(Date.now() + 1000).toISOString() }; return { data: current } as any;
  });
  render(<GalleryPrintShop slug="fixture" photos={[photo]} />); await addItem();
  fireEvent.click(screen.getByRole('button', { name: 'Review selections and final total' }));
  const confirm = await screen.findByRole('button', { name: 'Confirm order and request invoice' });
  expect(screen.getByText(/Confirm by/)).toBeInTheDocument(); fireEvent.click(screen.getByRole('checkbox')); expect(confirm).toBeEnabled();
  await waitFor(() => expect(confirm).toBeDisabled(), { timeout: 2500 });
  expect(await screen.findByText(/This preparation has expired/)).toBeInTheDocument();
  expect(api.post).toHaveBeenCalledTimes(1);
});
it('hides fulfilment downloads and review actions until a ready basket is confirmed', async () => {
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/orders') ? { orders: [quotation] } :
    { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } }) as any);
  render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>); await screen.findByText('Awaiting confirmation');
  expect(screen.queryByRole('button', { name: 'Supplier pack' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Studio order sheet' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'I checked these production files' })).not.toBeInTheDocument();
});
it('offers controlled repair for a confirmed order before lab submission', async () => {
  const order = { ...quotation, status: 'accepted', acceptedAt: '2026-11-01', invoiceId: 42 };
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/orders') ? { orders: [order] } :
    { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } }) as any);
  vi.mocked(api.post).mockResolvedValueOnce({ data: { ...order, renderStatus: 'queued', artworkVersion: null, repair: 'queued' } } as any);
  render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Check and repair production files' }));
  await screen.findByText('Artwork queued');
  expect(screen.getByText('Repair queued. Review the new production files before submitting them to the lab.')).toBeInTheDocument();
  expect(api.post).toHaveBeenCalledWith('/admin/print-sales/orders/order-1/actions', expect.objectContaining({ action: 'repair' }));
});
it('confirms when checked production files need no repair', async () => {
  const order = { ...quotation, status: 'accepted', acceptedAt: '2026-11-01', invoiceId: 42 };
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.includes('/orders') ? { orders: [order] } :
    { revision: 1, profiles: [], countries: ['IE'], policy: 'Policy', shippingPresetId: null, products: [], presets: [] } }) as any);
  vi.mocked(api.post).mockResolvedValueOnce({ data: { ...order, repair: 'healthy' } } as any);
  render(<MemoryRouter><PrintSalesAdminPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Check and repair production files' }));
  await screen.findByText('Production files checked; no repair needed.');
});
