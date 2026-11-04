import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GalleryProductPanel } from '../GalleryProductPanel';
import { GuidedAlbumFlow } from '../GuidedAlbumFlow';
import { availableOptions, pruneValues } from '../ConfigurationPicker';
import { albumProducts, type Offer } from '../model';
import { api } from '../../../config/api';
import { galleryService } from '../../../services/gallery.service';
import { attributes, offer, product } from './fixtures';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (_key: string, fallback: string, vars: Record<string, unknown> = {}) => Object.entries(vars).reduce((text, [k, v]) => text.replace(`{{${k}}}`, String(v)), fallback) }),
}));
vi.mock('../ProductImage', () => ({ ProductImage: ({ alt, imageId }: { alt: string; imageId: string | null }) => <span data-testid="product-image">{`Image: ${alt} ${imageId}`}</span> }));
vi.mock('../../../components/common/AuthenticatedImage', () => ({ AuthenticatedImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));
vi.mock('../../../config/api', () => ({ api: { put: vi.fn() } }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { getGalleryPhotos: vi.fn() } }));
vi.mock('../model', async (importOriginal) => {
  const original = await importOriginal<typeof import('../model')>();
  return { ...original, albumProducts: { ...original.albumProducts, client: vi.fn() } };
});

const photo = (id: number, extra: object = {}) => ({ id, filename: `${id}.jpg`, type: 'individual', thumbnail_url: `/api/gallery/wedding/thumbnail/${id}?wm=1`, ...extra });
const answer = (body: Partial<Offer>) => ({ data: { ...offer(), revision: 2, ...body } });
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const heading = (name: string) => screen.findByRole('heading', { name });

function mount(offers: Offer[] = [offer()], props: { startOfferId?: string } = {}) {
  const onClose = vi.fn();
  render(<GuidedAlbumFlow offers={offers} slug="wedding" onClose={onClose} {...props} />);
  return onClose;
}
async function throughSize() {
  next();
  await heading('Choose a material');
  fireEvent.click(screen.getByRole('radio', { name: 'Silk' }));
  next();
  await heading('Choose a colour');
  fireEvent.click(screen.getByRole('radio', { name: 'Ivory' }));
  next();
  await heading('Compare the formats');
  fireEvent.click(screen.getByRole('radio', { name: /Square/ }));
  next();
  await heading('Choose a size');
  fireEvent.click(screen.getByRole('radio', { name: '25 × 50 cm' }));
  next();
}
async function toReview() {
  await throughSize();
  await heading('Choose your cover photo');
  fireEvent.click(await screen.findByRole('button', { name: 'Photo 1' }));
  next();
  await heading('Choose your poster photos');
  fireEvent.click(await screen.findByRole('button', { name: 'Photo 2' }));
  next();
  await heading('Review your album');
}

beforeEach(() => {
  vi.mocked(galleryService.getGalleryPhotos).mockResolvedValue({
    photos: [photo(1), photo(2), photo(3), photo(4, { visibility: 'hidden' }), photo(5, { media_type: 'video' }), photo(6, { type: 'video' })],
  } as never);
  vi.mocked(api.put).mockImplementation(async (_url, body) => answer({ revision: (body as { revision: number }).revision + 1, status: (body as { submit: boolean }).submit ? 'submitted' : 'draft' }) as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('dependent options', () => {
  it('offers the colours of the chosen material only', () => {
    const colour = attributes[1];
    expect(availableOptions(colour, { material: ['silk'] }).map((o) => o.name)).toEqual(['Ivory']);
    expect(availableOptions(colour, { material: ['cotton'] }).map((o) => o.name)).toEqual(['Natural', 'Black']);
    expect(availableOptions(colour, {}).map((o) => o.name)).toEqual([]);
  });
  it('drops a choice its parent no longer allows, keeps one it does', () => {
    expect(pruneValues(attributes, { material: ['silk'], colour: ['natural'], format: ['square'], size: ['l2570'] })).toMatchObject({ colour: [], size: [] });
    expect(pruneValues(attributes, { material: ['leather'], colour: ['black'] })).toMatchObject({ colour: ['black'] });
  });
});

describe('guided album flow', () => {
  it('walks album, material, colour, format, size, cover, posters, review in that order', async () => {
    mount();
    await heading('Choose your album');
    expect(screen.getByText('Step 1 of 8')).toBeInTheDocument();
    expect(screen.getByText('Image: Fine art album hero')).toBeInTheDocument();
    expect(screen.getByText('Layflat pages')).toBeInTheDocument();
    await toReview();
    expect(screen.getByText('Step 8 of 8')).toBeInTheDocument();
    const summary = within(screen.getByRole('dialog'));
    for (const text of ['Fine art album', 'Silk', 'Ivory', 'Square', '25 × 50 cm', 'Cover photo', 'Poster photos']) expect(summary.getByText(text)).toBeInTheDocument();
    expect(summary.getAllByRole('img', { name: 'Selected photo' }).map((img) => img.getAttribute('src'))).toEqual(['/api/gallery/wedding/thumbnail/1?wm=1', '/api/gallery/wedding/thumbnail/2?wm=1']);
  });

  it('holds each step until it is answered', async () => {
    mount();
    next();
    await heading('Choose a material');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Cotton' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('shows colours as labelled round radios, filtered to the material, with a selected state', async () => {
    mount();
    next();
    await heading('Choose a material');
    fireEvent.click(screen.getByRole('radio', { name: 'Cotton' }));
    next();
    await heading('Choose a colour');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => (r.closest('label') as HTMLElement).textContent)).toEqual(['Natural', 'Black']);
    expect(screen.queryByRole('radio', { name: 'Ivory' })).not.toBeInTheDocument();
    const swatch = (r: HTMLElement) => (r.closest('label') as HTMLElement).querySelector('[data-swatch]') as HTMLElement;
    expect(swatch(radios[0]).className).toContain('rounded-full');
    expect(swatch(radios[0]).style.backgroundColor).toBe('rgb(216, 207, 192)');
    expect(swatch(radios[0]).querySelector('svg')).toBeNull();
    fireEvent.click(radios[0]);
    expect(radios[0]).toBeChecked();
    expect(swatch(radios[0]).querySelector('svg')).not.toBeNull();
    // Native radios in one group: the arrow keys and focus come with them.
    expect(new Set(radios.map((r) => (r as HTMLInputElement).name)).size).toBe(1);
    radios[0].focus();
    expect(document.activeElement).toBe(radios[0]);
    expect(swatch(radios[0]).className).toContain('peer-focus-visible:ring-2');
  });

  it('draws both formats side by side, to their true ratio and one scale', async () => {
    mount();
    next();
    await heading('Choose a material');
    fireEvent.click(screen.getByRole('radio', { name: 'Silk' }));
    next();
    await heading('Choose a colour');
    fireEvent.click(screen.getByRole('radio', { name: 'Ivory' }));
    next();
    await heading('Compare the formats');
    const [landscape, square] = ['Landscape', 'Square'].map((name) => screen.getByRole('radio', { name: new RegExp(name) }).closest('label') as HTMLElement);
    expect((landscape.parentElement as HTMLElement).className).toContain('grid-cols-2');
    expect(landscape).toHaveTextContent('25 × 70 cm30 × 80 cm');
    expect(square).toHaveTextContent('25 × 50 cm30 × 60 cm');
    const outline = (card: HTMLElement) => card.querySelector('[data-ratio]') as HTMLElement;
    expect(outline(landscape).dataset.ratio).toBe('800:300');
    expect(outline(square).dataset.ratio).toBe('600:300');
    // One box for both, in millimetres: the square format draws at 600 of 800.
    expect(outline(landscape).getAttribute('viewBox')).toBe('0 0 800 300');
    expect(outline(square).getAttribute('viewBox')).toBe('0 0 800 300');
    expect(outline(landscape).querySelector('rect')?.getAttribute('width')).toBe('800');
    expect(outline(square).querySelector('rect')?.getAttribute('width')).toBe('600');
    expect(outline(square).querySelector('line[stroke-dasharray]')).not.toBeNull();
  });

  it('offers the sizes of the chosen format only, and a format change clears a size that no longer fits', async () => {
    mount();
    await throughSize();
    await heading('Choose your cover photo');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await heading('Choose a size');
    expect(screen.getAllByRole('radio').map((r) => (r.closest('label') as HTMLElement).textContent)).toEqual(['25 × 50 cm', '30 × 60 cm']);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await heading('Compare the formats');
    fireEvent.click(screen.getByRole('radio', { name: /Landscape/ }));
    next();
    await heading('Choose a size');
    expect(screen.getAllByRole('radio').map((r) => (r.closest('label') as HTMLElement).textContent)).toEqual(['25 × 70 cm', '30 × 80 cm']);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('offers authorised photos only, swaps a cover, removes and caps posters', async () => {
    mount();
    await throughSize();
    await heading('Choose your cover photo');
    await screen.findByRole('button', { name: 'Photo 1' });
    expect(screen.getAllByRole('button', { name: /^Photo / })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Photo 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Photo 2' }));
    expect(screen.getByRole('button', { name: 'Photo 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Photo 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 1 selected');
    next();
    await heading('Choose your poster photos');
    await screen.findByRole('button', { name: 'Photo 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Photo 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Photo 2' }));
    expect(screen.getByRole('button', { name: 'Photo 3' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('2 selected, choose 1 to 2');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(screen.getByRole('button', { name: 'Photo 3' })).toBeEnabled();
  });

  it('saves a draft on every step forward and carries the photos', async () => {
    mount();
    await toReview();
    const calls = vi.mocked(api.put).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(5);
    const last = calls[calls.length - 1][1] as Record<string, unknown>;
    expect(last).toMatchObject({ submit: false, productVersion: 'a'.repeat(64), photoRoles: { cover: [1], poster: [2] }, values: { material: ['silk'], colour: ['ivory'], format: ['square'], size: ['s2550'] } });
    expect(last).not.toHaveProperty('name');
    expect(calls.map((c) => (c[1] as { revision: number }).revision)).toEqual(calls.map((_, i) => i + 1));
  });

  it('asks for a separate, explicit confirmation and then turns read-only', async () => {
    mount();
    await toReview();
    const confirm = screen.getByRole('button', { name: 'Confirm selection' });
    expect(confirm).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Anna' } });
    fireEvent.click(confirm);
    expect(api.put).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ submit: true }));
    const warning = screen.getByRole('alertdialog');
    expect(warning).toHaveTextContent('Attention: After confirmation, this selection can no longer be changed.');
    vi.mocked(api.put).mockResolvedValueOnce(answer({
      status: 'submitted',
      selection: { schemaVersion: 2, productVersion: '', product: { id: 'album-a', name: 'Fine art album' }, clientFinal: true, attributes: [], photoRoles: [{ key: 'cover', photos: [{ id: 1 }] }] },
    }) as never);
    fireEvent.click(within(warning).getByRole('button', { name: 'Confirm now' }));
    await screen.findByText(/Your selection is confirmed\. The studio has received it\./);
    expect(api.put).toHaveBeenLastCalledWith('/gallery/wedding/album-products/offer-a', expect.objectContaining({ submit: true, name: 'Anna' }));
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
  });

  it('retries a lost confirmation with the same mutation id', async () => {
    mount();
    await toReview();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Anna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }));
    vi.mocked(api.put).mockRejectedValueOnce(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm now' }));
    await screen.findByText('Connection lost');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm now' }));
    await waitFor(() => expect(vi.mocked(api.put).mock.calls.filter((c) => (c[1] as { submit: boolean }).submit)).toHaveLength(2));
    const [first, second] = vi.mocked(api.put).mock.calls.filter((c) => (c[1] as { submit: boolean }).submit);
    expect(first[1]).toEqual(second[1]);
  });

  it('a product without a final confirmation submits without the warning', async () => {
    mount([offer({ product: product('album-a', 'Open album', { guided: { clientFinal: false, photoRoles: [{ key: 'cover', min: 1, max: 1 }, { key: 'poster', min: 0, max: 0 }] } }) })]);
    await throughSize();
    await heading('Choose your cover photo');
    fireEvent.click(await screen.findByRole('button', { name: 'Photo 1' }));
    next();
    await heading('Review your album');
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Anna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit choice' }));
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ submit: true })));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks to replace a photo the studio hid after the draft, and blocks the step until then', async () => {
    const draft = offer({
      selection: {
        schemaVersion: 2, productVersion: '', product: { id: 'album-a', name: 'Fine art album' },
        attributes: [
          { id: 'material', name: 'Material', addOn: false, options: [{ id: 'silk', name: 'Silk', imageId: null }] },
          { id: 'colour', name: 'Colour', addOn: false, options: [{ id: 'ivory', name: 'Ivory', imageId: null }] },
          { id: 'format', name: 'Format', addOn: false, options: [{ id: 'square', name: 'Square', imageId: null }] },
          { id: 'size', name: 'Size', addOn: false, options: [{ id: 's2550', name: '25 × 50 cm', imageId: null }] },
        ],
        photoRoles: [{ key: 'cover', photos: [{ id: 4, available: false }] }, { key: 'poster', photos: [] }],
      },
    });
    mount([draft]);
    await heading('Choose your cover photo');
    expect(screen.getByText('No longer available, please replace it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Photo 2' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('reaches a later hidden photo: the draft saves once both are replaced', async () => {
    const draft = offer({
      selection: {
        schemaVersion: 2, productVersion: '', product: { id: 'album-a', name: 'Fine art album' },
        attributes: [
          { id: 'material', name: 'Material', addOn: false, options: [{ id: 'silk', name: 'Silk', imageId: null }] },
          { id: 'colour', name: 'Colour', addOn: false, options: [{ id: 'ivory', name: 'Ivory', imageId: null }] },
          { id: 'format', name: 'Format', addOn: false, options: [{ id: 'square', name: 'Square', imageId: null }] },
          { id: 'size', name: 'Size', addOn: false, options: [{ id: 's2550', name: '25 × 50 cm', imageId: null }] },
        ],
        photoRoles: [{ key: 'cover', photos: [{ id: 4, available: false }] }, { key: 'poster', photos: [{ id: 4, available: false }] }],
      },
    });
    mount([draft]);
    await heading('Choose your cover photo');
    fireEvent.click(await screen.findByRole('button', { name: 'Photo 1' }));
    next();
    await heading('Choose your poster photos');
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Photo 2' }));
    next();
    await heading('Review your album');
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.put).mock.calls[0][1]).toMatchObject({ photoRoles: { cover: [1], poster: [2] } });
  });

  it('drops the saved photos of a role the studio turned off', async () => {
    const draft = offer({
      product: product('album-a', 'Fine art album', { guided: { clientFinal: true, photoRoles: [{ key: 'cover', min: 1, max: 1 }, { key: 'poster', min: 0, max: 0 }] } }),
      selection: {
        schemaVersion: 2, productVersion: '', product: { id: 'album-a', name: 'Fine art album' },
        attributes: [
          { id: 'material', name: 'Material', addOn: false, options: [{ id: 'silk', name: 'Silk', imageId: null }] },
          { id: 'colour', name: 'Colour', addOn: false, options: [{ id: 'ivory', name: 'Ivory', imageId: null }] },
          { id: 'format', name: 'Format', addOn: false, options: [{ id: 'square', name: 'Square', imageId: null }] },
          { id: 'size', name: 'Size', addOn: false, options: [{ id: 's2550', name: '25 × 50 cm', imageId: null }] },
        ],
        photoRoles: [{ key: 'cover', photos: [] }, { key: 'poster', photos: [{ id: 2, available: true }] }],
      },
    });
    mount([draft]);
    await heading('Choose your cover photo');
    fireEvent.click(await screen.findByRole('button', { name: 'Photo 1' }));
    next();
    await heading('Review your album');
    expect(vi.mocked(api.put).mock.calls[0][1]).toMatchObject({ photoRoles: { cover: [1], poster: [] } });
    expect(screen.queryByRole('heading', { name: /poster/i })).toBeNull();
  });

  it('lets a draft over a lowered photo limit move on to the step that fixes it', async () => {
    const draft = offer({
      product: product('album-a', 'Fine art album', { guided: { clientFinal: true, photoRoles: [{ key: 'cover', min: 1, max: 1 }, { key: 'poster', min: 1, max: 1 }] } }),
      selection: {
        schemaVersion: 2, productVersion: '', product: { id: 'album-a', name: 'Fine art album' },
        attributes: [
          { id: 'material', name: 'Material', addOn: false, options: [{ id: 'silk', name: 'Silk', imageId: null }] },
          { id: 'colour', name: 'Colour', addOn: false, options: [{ id: 'ivory', name: 'Ivory', imageId: null }] },
          { id: 'format', name: 'Format', addOn: false, options: [{ id: 'square', name: 'Square', imageId: null }] },
          { id: 'size', name: 'Size', addOn: false, options: [{ id: 's2550', name: '25 × 50 cm', imageId: null }] },
        ],
        photoRoles: [{ key: 'cover', photos: [{ id: 1, available: true }] }, { key: 'poster', photos: [{ id: 2, available: true }, { id: 3, available: true }] }],
      },
    });
    mount([draft]);
    await heading('Choose your poster photos');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await heading('Choose your cover photo');
    next();
    await heading('Choose your poster photos');
    expect(api.put).not.toHaveBeenCalled();
  });

  it('shows the base price and every surcharge where the studio shows prices', async () => {
    const surcharges = [
      { attributeId: 'material', optionId: 'silk', amountMinor: 1500 },
      { attributeId: 'colour', optionId: 'ivory', amountMinor: 200 },
      { attributeId: 'format', optionId: 'square', amountMinor: 300 },
      { attributeId: 'size', optionId: 's2550', amountMinor: 400 },
    ];
    mount([offer({ pricing: { currency: 'EUR', baseUnitPriceMinor: 12000, surcharges } })]);
    expect(await screen.findByText(/Indicative base price/)).toHaveTextContent(/120/);
    next();
    await heading('Choose a material');
    expect(screen.getByRole('radio', { name: /Silk/ }).closest('label')).toHaveTextContent(/\+.*15/);
    fireEvent.click(screen.getByRole('radio', { name: /Silk/ }));
    next();
    await heading('Choose a colour');
    expect(screen.getByRole('radio', { name: /Ivory/ }).closest('label')).toHaveTextContent(/\+.*2/);
    fireEvent.click(screen.getByRole('radio', { name: /Ivory/ }));
    next();
    await heading('Compare the formats');
    expect(screen.getByRole('radio', { name: /Square/ }).closest('label')).toHaveTextContent(/\+.*3/);
    fireEvent.click(screen.getByRole('radio', { name: /Square/ }));
    next();
    await heading('Choose a size');
    expect(screen.getByRole('radio', { name: /25 × 50 cm/ }).closest('label')).toHaveTextContent(/\+.*4/);
  });

  it('shows no price without the studio\'s pricing', async () => {
    mount();
    await heading('Choose your album');
    expect(screen.queryByText(/Indicative base price/)).toBeNull();
  });

  it('shows the server\'s refusal and stays on the step', async () => {
    mount();
    next();
    await heading('Choose a material');
    fireEvent.click(screen.getByRole('radio', { name: 'Silk' }));
    vi.mocked(api.put).mockRejectedValueOnce({ response: { data: { error: 'This combination of options is not available' } } });
    next();
    await screen.findByText('This combination of options is not available');
    expect(screen.getByRole('heading', { name: 'Choose a material' })).toBeInTheDocument();
  });

  it('lets a client compare several albums, each with its title and image', async () => {
    const offers = [offer(), offer({ id: 'offer-b', productId: 'album-b', product: product('album-b', 'Panorama album', { heroImageId: 'hero-b', description: 'Wide' }) })];
    mount(offers);
    await heading('Choose your album');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Panorama album/ }));
    expect(screen.getByRole('button', { name: /Panorama album/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Image: Panorama album hero-b')).toBeInTheDocument();
    expect(screen.getByText('Wide')).toBeInTheDocument();
    next();
    await heading('Choose a material');
  });

  it('shows a confirmed album read-only, whatever the deep link says', async () => {
    const done = offer({
      id: 'offer-b', status: 'locked',
      selection: { schemaVersion: 2, productVersion: '', product: { id: 'album-b', name: 'Locked album' }, clientFinal: true, attributes: [], photoRoles: [] },
    });
    mount([offer(), done], { startOfferId: 'offer-a' });
    expect(await screen.findByText('Locked album')).toBeInTheDocument();
    expect(screen.getByText(/confirmed and locked by the studio/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('closes on Escape and takes focus into the dialog', async () => {
    const onClose = mount();
    await heading('Choose your album');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Choose your album' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('gallery entry', () => {
  it('stays invisible with nothing released', async () => {
    vi.mocked(albumProducts.client).mockResolvedValue([]);
    const { container } = render(<GalleryProductPanel slug="wedding" />);
    await waitFor(() => expect(albumProducts.client).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
  it('opens the flow from the entry, keeps a classic product in the choices list', async () => {
    vi.mocked(albumProducts.client).mockResolvedValue([offer(), offer({ id: 'classic', productId: 'c', product: { ...product('c', 'Prints'), guided: undefined, heroImageId: null } })]);
    render(<GalleryProductPanel slug="wedding" />);
    expect(await screen.findByText('Prints')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure your album' }));
    await heading('Choose your album');
  });
  it('an editable draft follows the product once the studio turns guiding off', async () => {
    const selection = { attributes: [], product: { name: 'Plain album' }, photoRoles: [{ key: 'cover', photos: [{ id: 1 }] }] };
    vi.mocked(albumProducts.client).mockResolvedValue([offer({ selection: selection as never, product: product('album-a', 'Plain album', { guided: undefined }) })] as never);
    render(<GalleryProductPanel slug="wedding" />);
    expect(await screen.findByText('Your product choices')).toBeInTheDocument();
    expect(screen.queryByText('Your album')).toBeNull();
  });
  it('a confirmed album stays guided after the studio turns guiding off', async () => {
    const selection = { attributes: [], clientFinal: true, product: { name: 'Plain album' }, photoRoles: [{ key: 'cover', photos: [{ id: 1 }] }] };
    vi.mocked(albumProducts.client).mockResolvedValue([offer({ status: 'submitted', selection: selection as never, product: product('album-a', 'Plain album', { guided: undefined }) })] as never);
    render(<GalleryProductPanel slug="wedding" />);
    expect(await screen.findByText('Your selection is confirmed.')).toBeInTheDocument();
  });
  it('a view-only login sees the album but cannot start it, not even from a deep link', async () => {
    window.history.replaceState(null, '', '/gallery/wedding?album=offer-a');
    vi.mocked(albumProducts.client).mockResolvedValue([offer({ readOnly: true } as never)]);
    render(<GalleryProductPanel slug="wedding" />);
    expect(await screen.findByText('Your login can view this choice but not make it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure your album' })).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('a deep link opens the released album directly', async () => {
    window.history.replaceState(null, '', '/gallery/wedding?album=offer-a');
    vi.mocked(albumProducts.client).mockResolvedValue([offer()]);
    render(<GalleryProductPanel slug="wedding" />);
    await heading('Choose your album');
  });
  it('the link to the album choice opens it, and closing clears the link', async () => {
    window.history.replaceState(null, '', '/gallery/wedding?album=choose&x=1');
    vi.mocked(albumProducts.client).mockResolvedValue([offer(), offer({ id: 'offer-b', product: product('album-b', 'Panorama album') })]);
    render(<GalleryProductPanel slug="wedding" />);
    await heading('Choose your album');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.search).toBe('?x=1');
  });
  it('a deep link to an offer this client cannot see opens nothing', async () => {
    window.history.replaceState(null, '', '/gallery/wedding?album=someone-elses');
    vi.mocked(albumProducts.client).mockResolvedValue([offer()]);
    render(<GalleryProductPanel slug="wedding" />);
    await screen.findByRole('button', { name: 'Configure your album' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('catalogue feedback (issue 2397)', () => {
  const two = () => [offer(), offer({ id: 'offer-b', productId: 'album-b', product: product('album-b', 'Linen album', { heroImageId: 'hero-b' }) })];
  let scroll: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll as never;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
  });

  it('scrolls smoothly to the album picked, without throwing the list back to its top', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    mount(two());
    const list = screen.getByRole('dialog').querySelector('.overflow-y-auto') as HTMLElement;
    list.scrollTop = 600;
    fireEvent.click(screen.getByRole('button', { name: /Linen album/ }));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' }));
    expect(list.scrollTop).toBe(600);
    expect(scroll.mock.contexts[0]).toHaveTextContent('Linen album');
    // Picking the same album again shows it again.
    fireEvent.click(screen.getByRole('button', { name: /Linen album/ }));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
  });

  it('jumps without animation for a client who asked for reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    mount(two());
    fireEvent.click(screen.getByRole('button', { name: /Fine art album/ }));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' }));
  });

  it('does not scroll before anything is picked', () => {
    mount(two());
    expect(scroll).not.toHaveBeenCalled();
  });

  it('explains the cover on the cover step, and only there', async () => {
    mount();
    await throughSize();
    await heading('Choose your cover photo');
    expect(screen.getByText('The cover photo is on the outside of the album, the first thing anyone sees before opening it.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Photo 1' }));
    next();
    await heading('Choose your poster photos');
    expect(screen.queryByText(/on the outside of the album/)).not.toBeInTheDocument();
  });
});
