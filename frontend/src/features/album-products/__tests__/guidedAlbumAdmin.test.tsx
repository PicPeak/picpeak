import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { EventProductsCard } from '../EventProductsCard';
import { AlbumProductCataloguePage } from '../CataloguePage';
import { albumProducts, type Catalogue, type Offer } from '../model';
import { offer, product } from './fixtures';

const state = vi.hoisted(() => ({ permissions: new Set<string>(), confirm: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (_key: string, fallback: string, vars: Record<string, unknown> = {}) => Object.entries(vars).reduce((text, [k, v]) => text.replace(`{{${k}}}`, String(v)), fallback) }),
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: (key: string) => key === 'albumProducts' }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission: (key: string) => state.permissions.has(key) }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: (value: string) => value }) }));
vi.mock('../../../components/admin/AdminAuthenticatedImage', () => ({ AdminAuthenticatedImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));
vi.mock('../../../components/admin/SettingsSaveBar', () => ({ SettingsSaveBar: ({ onSave }: { onSave: () => void }) => <button onClick={onSave}>Save catalogue</button> }));
vi.mock('../ProductImage', () => ({ ProductImage: ({ alt }: { alt: string }) => <span>{`Image: ${alt}`}</span> }));
vi.mock('../../../components/common', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../components/common')>(),
  useConfirm: () => state.confirm,
}));
vi.mock('../model', async (importOriginal) => {
  const original = await importOriginal<typeof import('../model')>();
  return { ...original, albumProducts: { event: vi.fn(), update: vi.fn(), assign: vi.fn(), history: vi.fn(), catalogue: vi.fn(), save: vi.fn(), upload: vi.fn() } };
});

const customers = [{ id: 1, name: 'Anna' }, { id: 2, name: 'Ben' }];
const album = product();
const load = (offers: Offer[], extra: object = {}) =>
  vi.mocked(albumProducts.event).mockResolvedValue({ catalogue: { revision: 1, products: [album] }, offers, customers: [], ...extra });
const mount = (owns = true) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><EventProductsCard eventId={7} ownsEvent={owns} slug="wedding" /></MemoryRouter>
  </QueryClientProvider>,
);
const selection = {
  schemaVersion: 2, productVersion: '', product: { id: 'album-a', name: 'Fine art album' }, clientFinal: true,
  attributes: [
    { id: 'material', name: 'Material', addOn: false, role: 'material' as const, options: [{ id: 'silk', name: 'Silk', imageId: null }] },
    { id: 'colour', name: 'Colour', addOn: false, role: 'colour' as const, options: [{ id: 'ivory', name: 'Ivory', imageId: null, hex: '#f4ecd8' }] },
    { id: 'format', name: 'Format', addOn: false, role: 'format' as const, options: [{ id: 'square', name: 'Square', imageId: null }] },
    { id: 'size', name: 'Size', addOn: false, role: 'size' as const, options: [{ id: 's2550', name: '25 × 50 cm', imageId: null }] },
  ],
  photoRoles: [
    { key: 'cover' as const, photos: [{ id: 11, filename: 'cover.jpg', originalFilename: 'DSC_1.jpg', available: true }] },
    { key: 'poster' as const, photos: [{ id: 12, filename: 'poster.jpg', originalFilename: null, available: false }] },
  ],
};

beforeEach(() => {
  state.permissions = new Set(['products.view', 'products.configure', 'products.manage']);
  state.confirm.mockReset().mockResolvedValue(true);
  vi.mocked(albumProducts.update).mockResolvedValue(offer());
  vi.mocked(albumProducts.assign).mockResolvedValue(offer());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('studio gallery card', () => {
  it('makes the release state obvious and releases on an explicit action', async () => {
    load([offer({ enabled: false })]);
    mount();
    expect(await screen.findByText('Not released')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy client link' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Release to client' }));
    await waitFor(() => expect(albumProducts.update).toHaveBeenCalledWith(7, expect.anything(), { enabled: true }));
  });
  it('offers to withdraw a released album', async () => {
    load([offer()]);
    mount();
    expect(await screen.findByText('Released')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw release' }));
    await waitFor(() => expect(albumProducts.update).toHaveBeenCalledWith(7, expect.anything(), { enabled: false }));
  });
  it('gives a customer\'s release the portal link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    load([offer({ releasedCustomerId: 1 })], { customers });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy client link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/customer/events/wedding`));
  });
  it('shows album, options and photo roles in one summary, with filenames and missing photos', async () => {
    load([offer({ status: 'submitted', selection })]);
    mount();
    expect(await screen.findByText('Confirmed by the client')).toBeInTheDocument();
    for (const text of ['Fine art album', 'Silk', 'Ivory', 'Square', '25 × 50 cm', 'Cover photo', 'Poster photos', 'cover.jpg', 'DSC_1.jpg', 'poster.jpg', 'No longer available'])
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'cover.jpg' })).toHaveAttribute('src', '/admin/photos/7/thumbnail/11');
  });
  it('reopens only after the question is answered, and only for the owner', async () => {
    load([offer({ status: 'locked', selection })]);
    mount();
    const reopen = await screen.findByRole('button', { name: 'Reopen for the client' });
    expect(screen.queryByRole('button', { name: 'Allow changes' })).not.toBeInTheDocument();
    state.confirm.mockResolvedValueOnce(false);
    fireEvent.click(reopen);
    await waitFor(() => expect(state.confirm).toHaveBeenCalled());
    expect(albumProducts.update).not.toHaveBeenCalled();
    fireEvent.click(reopen);
    await waitFor(() => expect(albumProducts.update).toHaveBeenCalledWith(7, expect.anything(), { action: 'reopen' }));
    cleanup();
    mount(false);
    await screen.findByText('Locked by the studio');
    expect(screen.queryByRole('button', { name: 'Reopen for the client' })).not.toBeInTheDocument();
  });
  it('a teammate without configure rights sees the summary but no release or reopen', async () => {
    state.permissions = new Set(['products.view']);
    load([offer({ status: 'submitted', selection })]);
    mount();
    await screen.findByText('Confirmed by the client');
    expect(screen.queryByRole('button', { name: 'Withdraw release' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen for the client' })).not.toBeInTheDocument();
  });
  it('limits an offer to one customer, warns about a shared one, and freezes the audience with a choice', async () => {
    load([offer()], { customers });
    mount();
    await screen.findByText(/none of them sees this offer/);
    const select = screen.getAllByLabelText('Who gets this offer')[0];
    fireEvent.change(select, { target: { value: '2' } });
    await waitFor(() => expect(albumProducts.update).toHaveBeenCalledWith(7, expect.anything(), { releasedCustomerId: 2 }));
    cleanup();
    load([offer({ selection, releasedCustomerId: 1 })], { customers });
    mount();
    expect(await screen.findByText('For Anna only')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Who gets this offer')[0]).toBeDisabled();
    expect(screen.queryByText(/none of them sees this offer/)).not.toBeInTheDocument();
  });
  it('adds one offer per customer for the same album', async () => {
    load([offer({ releasedCustomerId: 1 })], { customers });
    mount();
    await screen.findByText('For Anna only');
    fireEvent.change(screen.getAllByLabelText('Who gets this offer')[1], { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Offer a product'), { target: { value: 'album-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to gallery' }));
    await waitFor(() => expect(albumProducts.assign).toHaveBeenCalledWith(7, 'album-a', 2));
  });
  it('reads the history when the studio opens it', async () => {
    vi.mocked(albumProducts.history).mockResolvedValue([{ id: 'h', revision: 3, status: 'submitted', actor_type: 'client', actor_name: 'Anna', created_at: '2026-11-01' }]);
    load([offer({ status: 'submitted', selection })]);
    const { container } = mount();
    await screen.findByText('Choice history');
    expect(albumProducts.history).not.toHaveBeenCalled();
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(await screen.findByText(/Anna/)).toBeInTheDocument();
  });
});

describe('catalogue', () => {
  const catalogue = (): Catalogue => ({ revision: 1, products: [{ ...product('p', 'Plain album', { guided: undefined, heroImageId: null, attributes: undefined }) }], library: [], types: [{ id: 'type', name: 'Album', active: true, attributes: [] }] });
  const open = async () => {
    vi.mocked(albumProducts.catalogue).mockResolvedValue(catalogue());
    vi.mocked(albumProducts.save).mockImplementation(async (value) => value);
    render(<MemoryRouter><AlbumProductCataloguePage /></MemoryRouter>);
    await screen.findByDisplayValue('Plain album');
  };
  const sent = () => vi.mocked(albumProducts.save).mock.calls[0][0];
  const save = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save catalogue' }));
    await waitFor(() => expect(albumProducts.save).toHaveBeenCalled());
  };
  it('turns a product into a guided album with studio-set photo counts', async () => {
    await open();
    fireEvent.click(screen.getByRole('switch', { name: 'Guided album order' }));
    fireEvent.change(screen.getByLabelText('Poster photos, at least'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Poster photos, at most'), { target: { value: '4' } });
    await save();
    expect(sent().products[0].guided).toEqual({ clientFinal: true, photoRoles: [{ key: 'cover', min: 1, max: 1 }, { key: 'poster', min: 2, max: 4 }] });
  });
  it('keeps the poster range valid whichever end moves', async () => {
    await open();
    fireEvent.click(screen.getByRole('switch', { name: 'Guided album order' }));
    fireEvent.change(screen.getByLabelText('Poster photos, at least'), { target: { value: '5' } });
    expect(screen.getByLabelText('Poster photos, at most')).toHaveValue(5);
    fireEvent.change(screen.getByLabelText('Poster photos, at most'), { target: { value: '1' } });
    expect(screen.getByLabelText('Poster photos, at least')).toHaveValue(1);
  });
  it('uploads a hero image for the product', async () => {
    vi.mocked(albumProducts.upload).mockResolvedValue({ id: 'hero-1' });
    await open();
    fireEvent.change(screen.getByLabelText('Product image (PNG, up to 6 MB)'), { target: { files: [new File(['png'], 'hero.png', { type: 'image/png' })] } });
    await waitFor(() => expect(albumProducts.upload).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Remove image' });
    await save();
    expect(sent().products[0].heroImageId).toBe('hero-1');
  });
  it('the starter set is editable catalogue data: three materials, the four sizes, both dependencies', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add album starter set' }));
    await save();
    const { library = [], types = [] } = sent();
    expect(library.map((g) => g.kind)).toEqual(['choice', 'colour', 'choice', 'size']);
    expect(library[0].options.map((o) => o.name)).toEqual(['Cotton', 'Silk', 'Leather']);
    expect(library[3].options.map((o) => [o.name, o.width, o.height])).toEqual([['25 × 70 cm', 70, 25], ['30 × 80 cm', 80, 30], ['25 × 50 cm', 50, 25], ['30 × 60 cm', 60, 30]]);
    const type = types[types.length - 1];
    expect(type.attributes.map((a) => a.role)).toEqual(['material', 'colour', 'format', 'size']);
    expect(type.attributes[1].availableWhen?.attributeId).toBe(type.attributes[0].id);
    expect(type.attributes[3].availableWhen?.attributeId).toBe(type.attributes[2].id);
    const cotton = library[0].options[0].id;
    const cottonColours = library[1].options.filter((o) => type.attributes[1].availableWhen?.options[o.id]?.includes(cotton));
    expect(cottonColours).toHaveLength(2);
    expect(library[1].options.every((o) => /^#[0-9a-f]{6}$/.test(o.hex || ''))).toBe(true);
  });
  it('edits a colour value, an attribute role and a dependency', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add album starter set' }));
    const colourPickers = await screen.findAllByLabelText('Colour value');
    fireEvent.change(colourPickers[0], { target: { value: '#112233' } });
    const roles = screen.getAllByLabelText('Role in a guided album');
    expect(roles).toHaveLength(4);
    // A role taken by another attribute is not on offer twice.
    expect([...(roles[0] as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'material']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Natural' })).getByRole('checkbox', { name: 'Silk' }));
    await save();
    const { library = [], types = [] } = sent();
    expect(library[1].options[0].hex).toBe('#112233');
    const silk = library[0].options[1].id;
    expect(types[1].attributes[1].availableWhen?.options[library[1].options[0].id]).toContain(silk);
  });
});
