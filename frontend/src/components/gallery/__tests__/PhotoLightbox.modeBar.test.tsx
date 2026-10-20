/**
 * The lightbox bar's Select / Annotate switch (issue 1733, item E1).
 *
 * Drawing is entered and left from one visible, keyboard-reachable control in
 * the bar instead of a button deep in the comment form; Escape leaves the
 * mode before it closes the lightbox; and every proofing action is in the
 * bar once, not again in the feedback panel.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: unknown, o?: { count?: number }) => (typeof d === 'string' ? d.replace('{{count}}', String(o?.count ?? '{{count}}')) : k),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn(),
    getPhotoFeedback: vi.fn(),
    submitFeedback: vi.fn(),
  },
}));
import { feedbackService } from '../../../services/feedback.service';
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
  Skeleton: () => null,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input placeholder={props.placeholder} />,
  Button: ({ children, onClick, type = 'button', disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../FeedbackIdentityModal', () => ({
  FeedbackIdentityModal: ({ isOpen, onSubmit }: { isOpen: boolean; onSubmit: (name: string, email: string) => void }) =>
    isOpen ? <button type="button" onClick={() => onSubmit('Ann', 'ann@example.test')}>Send identity</button> : null,
}));

import { PhotoLightbox } from '../PhotoLightbox';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photos = [1, 2, 3].map((id) => ({
  id, filename: `${id}.jpg`, url: `/api/gallery/g/photo/${id}`, thumbnail_url: `/t/${id}`, type: 'individual',
})) as Photo[];

const SETTINGS = {
  feedback_enabled: true, allow_comments: true, allow_annotations: true,
  allow_likes: false, allow_ratings: false, show_feedback_to_guests: true,
};

const sizes = { offsetWidth: 400, offsetHeight: 200, naturalWidth: 2000, naturalHeight: 1000 };
beforeAll(() => {
  for (const [key, value] of Object.entries(sizes)) {
    Object.defineProperty(HTMLImageElement.prototype, key, { configurable: true, get: () => value });
  }
});
afterAll(() => {
  for (const key of Object.keys(sizes)) {
    delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

const onClose = vi.fn();
function open(settings: Record<string, unknown> = SETTINGS, { panel = false } = {}) {
  vi.mocked(feedbackService.getGalleryFeedbackSettings).mockResolvedValue(settings as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PhotoLightbox photos={photos} initialIndex={0} onClose={onClose} slug="g" feedbackEnabled initialShowFeedback={panel} />
    </QueryClientProvider>,
  );
}

const key = (k: string, target: EventTarget = document) => act(() => { fireEvent.keyDown(target, { key: k }); });
const radio = (name: 'Select' | 'Annotate') => screen.getByRole('radio', { name });
const checked = (name: 'Select' | 'Annotate') => radio(name).getAttribute('aria-checked');
const tools = () => screen.queryByRole('toolbar', { name: 'Drawing tools' });

function drag(svg: Element) {
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.assign(event, { isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    act(() => { fireEvent(svg, event); });
  };
  pointer('pointerdown', 0, 0);
  pointer('pointermove', 400, 200);
  pointer('pointerup', 400, 200);
}

describe('PhotoLightbox — Select / Annotate bar (issue 1733, E1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(feedbackService.getPhotoFeedback).mockResolvedValue({
      feedback: [], my_feedback: {}, summary: {},
    } as never);
  });

  it('starts in Select and switches to Annotate and back, visibly', async () => {
    open();
    const group = await screen.findByRole('radiogroup', { name: 'Mode' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(checked('Select')).toBe('true');
    expect(checked('Annotate')).toBe('false');
    // Roving focus: one Tab stop for the pair.
    expect(radio('Select').tabIndex).toBe(0);
    expect(radio('Annotate').tabIndex).toBe(-1);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();

    fireEvent.click(radio('Annotate'));
    expect(checked('Annotate')).toBe('true');
    expect(tools()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();

    fireEvent.click(radio('Select'));
    expect(checked('Select')).toBe('true');
    expect(tools()).toBeNull();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
  });

  // The drawing travels with a comment: the panel and its form open with it.
  it('opens the comment form from a closed panel, and the finished drawing is attached there', async () => {
    open();
    await screen.findByRole('radiogroup', { name: 'Mode' });
    expect(screen.queryByPlaceholderText('Write a comment...')).toBeNull();

    fireEvent.click(radio('Annotate'));
    expect(await screen.findByPlaceholderText('Write a comment...')).toBeTruthy();
    drag(screen.getByTestId('annotation-overlay'));
    fireEvent.click(within(tools()!).getByRole('button', { name: 'Done' }));

    expect(checked('Select')).toBe('true');
    expect(screen.getByText('Drawing attached')).toBeTruthy();
  });

  it('Escape leaves Annotate first, puts focus back on the switch, and closes the lightbox only next', async () => {
    open();
    await screen.findByRole('radiogroup', { name: 'Mode' });
    fireEvent.click(radio('Annotate'));
    const done = within(tools()!).getByRole('button', { name: 'Done' });
    done.focus();

    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(tools()).toBeNull();
    expect(checked('Select')).toBe('true');
    // The focused tool is gone; focus lands on the switch, not the page.
    expect(document.activeElement).toBe(radio('Select'));

    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves between the modes with the arrow keys without paging the photo', async () => {
    open();
    await screen.findByRole('radiogroup', { name: 'Mode' });
    radio('Select').focus();

    key('ArrowRight', radio('Select'));
    expect(checked('Annotate')).toBe('true');
    expect(document.activeElement).toBe(radio('Annotate'));
    expect(screen.getByText('1 / 3')).toBeTruthy();

    key('ArrowLeft', radio('Annotate'));
    expect(checked('Select')).toBe('true');
    expect(document.activeElement).toBe(radio('Select'));
    expect(screen.getByText('1 / 3')).toBeTruthy();
  });

  it('suspends wheel zoom and the film strip while annotating', async () => {
    open();
    await screen.findByRole('radiogroup', { name: 'Mode' });
    fireEvent.click(radio('Annotate'));
    const track = screen.getByAltText('1.jpg').parentElement!.parentElement!.parentElement!;
    act(() => { fireEvent.wheel(track, { deltaY: -500 }); });
    fireEvent.click(radio('Select'));
    expect(screen.getByText('100%')).toBeTruthy();

    // The same wheel zooms once the mode is left.
    act(() => { fireEvent.wheel(track, { deltaY: -500 }); });
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('keeps each proofing action once: in the bar, not again in the panel or the form', async () => {
    open({ ...SETTINGS, allow_likes: true, allow_ratings: true, allow_favorites: true }, { panel: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Comment' }));

    // The bar's buttons.
    expect(screen.getAllByRole('button', { name: 'Add to favorites' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Like photo' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Rate 3 stars' })).toHaveLength(1);
    // Not the panel's copies.
    expect(screen.queryByRole('button', { name: 'Like' })).toBeNull();
    // The form points at the mode switch instead of carrying its own button.
    expect(screen.queryByRole('button', { name: 'Draw on photo' })).toBeNull();
    expect(screen.getByText('To draw on the photo, switch to Annotate.')).toBeTruthy();
  });

  it('saves a favourite from the bar', async () => {
    vi.mocked(feedbackService.getPhotoFeedback)
      .mockResolvedValueOnce({ feedback: [], my_feedback: {}, summary: {} } as never)
      .mockResolvedValue({ feedback: [], my_feedback: { favorited: true }, summary: { favorite_count: 1 } } as never);
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    open({ ...SETTINGS, allow_favorites: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith('g', '1', expect.objectContaining({ feedback_type: 'favorite' })));
    expect(await screen.findByRole('button', { name: 'Remove from favorites' })).toBeTruthy();
  });

  it('keeps a favourite made before the photo\'s feedback loaded', async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(feedbackService.getPhotoFeedback)
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }) as never)
      .mockResolvedValue({ feedback: [], my_feedback: { favorited: true }, summary: { favorite_count: 1 } } as never);
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    open({ ...SETTINGS, allow_favorites: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalled());

    // The load that was out before the click says: not a favourite.
    await act(async () => { answer({ feedback: [], my_feedback: { favorited: false }, summary: { favorite_count: 0 } }); });
    expect(screen.getByRole('button', { name: 'Remove from favorites' })).toBeTruthy();
  });

  it('shows what the server saved when the click came before the photo\'s feedback', async () => {
    // Already a favourite, but the bar does not know yet: the click removes it.
    let answer!: (value: unknown) => void;
    vi.mocked(feedbackService.getPhotoFeedback)
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }) as never)
      .mockResolvedValue({ feedback: [], my_feedback: { favorited: false }, summary: { favorite_count: 0 } } as never);
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    open({ ...SETTINGS, allow_favorites: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to favorites' }));

    await act(async () => { answer({ feedback: [], my_feedback: { favorited: true }, summary: { favorite_count: 1 } }); });
    expect(await screen.findByRole('button', { name: 'Add to favorites' })).toBeTruthy();
  });

  it('opens the comment form for a drawing finished before the panel had loaded', async () => {
    let settle!: (value: unknown) => void;
    vi.mocked(feedbackService.getGalleryFeedbackSettings)
      .mockResolvedValueOnce(SETTINGS as never)
      .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }) as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PhotoLightbox photos={photos} initialIndex={0} onClose={onClose} slug="g" feedbackEnabled />
      </QueryClientProvider>,
    );
    await screen.findByRole('radiogroup', { name: 'Mode' });

    fireEvent.click(radio('Annotate'));
    drag(screen.getByTestId('annotation-overlay'));
    fireEvent.click(within(tools()!).getByRole('button', { name: 'Done' }));
    expect(screen.queryByPlaceholderText('Write a comment...')).toBeNull();

    await act(async () => { settle(SETTINGS); });
    expect(await screen.findByPlaceholderText('Write a comment...')).toBeTruthy();
    expect(screen.getByText('Drawing attached')).toBeTruthy();
  });

  it('keeps the saved favourite over a load that went out while it was being saved', async () => {
    let save!: (value: unknown) => void;
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise((resolve) => { save = resolve; }) as never);
    open({ ...SETTINGS, allow_favorites: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalled());

    // Away and back while the save is out: that load reads the old state, late.
    let stale!: (value: unknown) => void;
    vi.mocked(feedbackService.getPhotoFeedback)
      .mockResolvedValueOnce({ feedback: [], my_feedback: {}, summary: {} } as never)
      .mockImplementationOnce(() => new Promise((resolve) => { stale = resolve; }) as never)
      .mockResolvedValue({ feedback: [], my_feedback: { favorited: true }, summary: { favorite_count: 1 } } as never);
    key('ArrowRight');
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy());
    key('ArrowLeft');
    await waitFor(() => expect(feedbackService.getPhotoFeedback).toHaveBeenCalledTimes(3));

    await act(async () => { save({ success: true }); });
    await waitFor(() => expect(feedbackService.getPhotoFeedback).toHaveBeenCalledTimes(4));
    await act(async () => { stale({ feedback: [], my_feedback: {}, summary: {} }); });
    expect(await screen.findByRole('button', { name: 'Remove from favorites' })).toBeTruthy();
  });

  // The bar's stars are the lightbox's only rating control now.
  it('says so when a rating from the bar is refused, and sends one at a time', async () => {
    const { toast } = await import('react-toastify');
    let refuse!: (err: unknown) => void;
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise((_, reject) => { refuse = reject; }) as never);
    open({ ...SETTINGS, allow_ratings: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Rate 4 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars' }));
    expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1);

    await act(async () => { refuse({ response: { status: 500 } }); });
    expect(toast.error).toHaveBeenCalledWith('Failed to submit rating');
    expect(screen.queryByRole('button', { name: 'Remove rating' })).toBeNull();
  });

  it('sends a rating for the next photo while the last one\'s is still out', async () => {
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise(() => {}) as never);
    open({ ...SETTINGS, allow_ratings: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Rate 4 stars' }));
    key('ArrowRight');
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Rate 3 stars' }));
    expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(2);
    expect(feedbackService.submitFeedback).toHaveBeenLastCalledWith('g', '2', expect.objectContaining({ rating: 3 }));
  });

  it('holds a second star while the rating sent from the name/email dialog is out', async () => {
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise(() => {}) as never);
    open({ ...SETTINGS, allow_ratings: true, require_name_email: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Rate 4 stars' }));
    const send = await screen.findByRole('button', { name: 'Send identity' });
    await act(async () => { fireEvent.click(send); });
    expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars' }));
    expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1);
  });
});
