/** Shipments on a confirmed album order in the admin (issue 2422). */
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { EventProductsCard } from '../EventProductsCard';

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  status: 'submitted',
  clientFinal: true,
  recipient: { id: 4, name: 'Anna', email: 'anna@example.com' } as { id: number; name: string; email: string } | null,
  shipments: [] as unknown[],
  addShipment: vi.fn(),
  removeShipment: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: unknown, opts?: Record<string, unknown>) =>
      typeof fb === 'string' ? fb.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts?.[key] ?? '')) : _k,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: (d: string) => d.slice(0, 10), formatDateTime: (d: string) => d }) }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: (key: string) => key === 'albumProducts' }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission: (key: string) => state.permissions.has(key) }) }));
vi.mock('../../../components/common', async () => ({
  ...(await vi.importActual<object>('../../../components/common')),
  useConfirm: () => state.confirm,
}));
vi.mock('../../print-sales/GallerySettings', () => ({ PrintGallerySettings: () => null }));
vi.mock('../model', async (importOriginal) => ({
  isConfirmed: (await importOriginal<typeof import('../model')>()).isConfirmed,
  CARRIERS: ['dhl', 'dhl_express', 'deutsche_post', 'dpd', 'hermes', 'gls', 'ups', 'fedex', 'other'],
  errorMessage: (error: Error) => error.message,
  albumProducts: {
    event: vi.fn(async () => ({
      catalogue: { products: [{ id: 'album', name: 'Album', active: true }] },
      offers: [{ id: 'offer', productId: 'album', enabled: true, revision: 1, status: state.status,
        selection: { schemaVersion: 2, productVersion: 'v', product: { id: 'album', name: 'Album' }, attributes: [], photoRoles: [], clientFinal: state.clientFinal } }],
    })),
    shipments: vi.fn(async () => ({ shipments: state.shipments, recipient: state.recipient })),
    addShipment: (...args: unknown[]) => state.addShipment(...args),
    removeShipment: (...args: unknown[]) => state.removeShipment(...args),
  },
}));

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><EventProductsCard eventId={7} ownsEvent /></MemoryRouter>
  </QueryClientProvider>);
}
beforeEach(() => {
  state.permissions = new Set(['products.view', 'products.configure']);
  state.status = 'submitted';
  state.clientFinal = true;
  state.recipient = { id: 4, name: 'Anna', email: 'anna@example.com' };
  state.shipments = [];
  state.addShipment.mockReset().mockResolvedValue({ shipment: {}, notification: 'queued' });
  state.removeShipment.mockReset().mockResolvedValue({});
  state.confirm.mockReset().mockResolvedValue(true);
});

it('adds a parcel with the mail ticked by default and names the recipient', async () => {
  mount();
  await screen.findByRole('heading', { name: 'Shipments' });
  const notify = await screen.findByRole('checkbox', { name: /Notify the customer by e-mail/ });
  expect(notify).toBeChecked();
  expect(screen.getByText('To Anna (anna@example.com), with the tracking link.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Tracking link (optional)')).toBeNull();
  fireEvent.change(screen.getByLabelText('Tracking number'), { target: { value: ' 1234 ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add parcel' }));
  await waitFor(() => expect(state.addShipment).toHaveBeenCalledWith(7, 'offer', { carrier: 'dhl', trackingNumber: '1234', notify: true }));
});

it('asks for a link only for another carrier and sends no mail when unticked', async () => {
  mount();
  fireEvent.change(await screen.findByLabelText('Carrier'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Tracking link (optional)'), { target: { value: 'https://track.example.com/1' } });
  fireEvent.change(screen.getByLabelText('Tracking number'), { target: { value: 'AB-1' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Notify the customer/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Add parcel' }));
  await waitFor(() => expect(state.addShipment).toHaveBeenCalledWith(7, 'offer', {
    carrier: 'other', trackingNumber: 'AB-1', trackingUrl: 'https://track.example.com/1', notify: false,
  }));
});

it('says nobody can be notified when the order has no customer account, and still saves', async () => {
  state.recipient = null;
  mount();
  expect(await screen.findByText(/No customer account belongs to this order/)).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /Notify the customer/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Tracking number'), { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add parcel' }));
  await waitFor(() => expect(state.addShipment).toHaveBeenCalledWith(7, 'offer', { carrier: 'dhl', trackingNumber: '9', notify: false }));
});

it('lists parcels with a tracking link and the mail state, and deletes after confirming', async () => {
  state.shipments = [
    { id: 5, offerId: 'offer', carrier: 'ups', carrierName: 'UPS', trackingNumber: '1Z9', trackingUrl: 'https://www.ups.com/track?tracknum=1Z9', shippedAt: '2026-11-05T10:00:00.000Z', notifiedAt: '2026-11-05T10:00:01.000Z', mail: 'sent' },
    { id: 4, offerId: 'offer', carrier: 'other', carrierName: null, trackingNumber: 'X1', trackingUrl: null, shippedAt: '2026-11-04T10:00:00.000Z', notifiedAt: null, mail: null },
    { id: 3, offerId: 'offer', carrier: 'dhl', carrierName: 'DHL', trackingNumber: 'D3', trackingUrl: 'https://x.test/D3', shippedAt: '2026-11-03T10:00:00.000Z', notifiedAt: '2026-11-03T10:00:01.000Z', mail: 'queued' },
    { id: 2, offerId: 'offer', carrier: 'dhl', carrierName: 'DHL', trackingNumber: 'D2', trackingUrl: 'https://x.test/D2', shippedAt: '2026-11-02T10:00:00.000Z', notifiedAt: '2026-11-02T10:00:01.000Z', mail: 'failed' },
  ];
  mount();
  const link = await screen.findByRole('link', { name: '1Z9' });
  expect(link).toHaveAttribute('href', 'https://www.ups.com/track?tracknum=1Z9');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const rows = within(link.closest('ul') as HTMLElement).getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('E-mail sent');
  expect(rows[1]).toHaveTextContent('Other carrier');
  expect(rows[1]).toHaveTextContent('Not notified');
  // Queued is not sent: business hours can hold it, retries can fail it.
  expect(rows[2]).toHaveTextContent('E-mail scheduled');
  expect(rows[3]).toHaveTextContent('E-mail failed');
  fireEvent.click(screen.getByRole('button', { name: 'Delete parcel 1Z9' }));
  await waitFor(() => expect(state.removeShipment).toHaveBeenCalledWith(7, 'offer', 5));
  expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger' }));
});

it('shows nothing for an unconfirmed order, and no form without products.configure', async () => {
  state.status = 'draft';
  const { unmount } = mount();
  await screen.findAllByText('Album');
  expect(screen.queryByRole('heading', { name: 'Shipments' })).toBeNull();
  unmount();
  // Submitted but not client-final: the client can still change it.
  state.status = 'submitted';
  state.clientFinal = false;
  const second = mount();
  await screen.findAllByText('Album');
  expect(screen.queryByRole('heading', { name: 'Shipments' })).toBeNull();
  second.unmount();
  // Reopened after a parcel was recorded: still listed and deletable, no new one.
  state.status = 'draft';
  state.shipments = [{ id: 6, offerId: 'offer', carrier: 'dpd', carrierName: 'DPD', trackingNumber: '2', trackingUrl: 'https://x.test/2', shippedAt: null, notifiedAt: null }];
  const third = mount();
  await screen.findByRole('link', { name: '2' });
  expect(screen.getByRole('button', { name: /Delete parcel/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add parcel' })).toBeNull();
  third.unmount();
  state.clientFinal = true;
  state.status = 'locked';
  state.permissions = new Set(['products.view']);
  state.shipments = [{ id: 5, offerId: 'offer', carrier: 'dhl', carrierName: 'DHL', trackingNumber: '1', trackingUrl: 'https://x.test/1', shippedAt: null, notifiedAt: null }];
  mount();
  await screen.findByRole('link', { name: '1' });
  expect(screen.queryByRole('button', { name: 'Add parcel' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Delete parcel/ })).toBeNull();
});
