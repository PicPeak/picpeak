/**
 * Annotate mode in the lightbox (issue 1733, item A2).
 *
 * While a guest draws on the photo the lightbox must not navigate, zoom or
 * close under the pointer: the keyboard, the chevrons and the gestures stand
 * down, Escape leaves the mode instead of the lightbox, and leaving restores
 * everything. The finished drawing travels with the comment, and a stored one
 * is shown from the comment list.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

const fallbackAlts = vi.hoisted(() => new Set<string>());
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k), i18n: { language: 'en' } }),
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
// The real barrel pulls in the i18n runtime; the panel only needs these.
vi.mock('../../common', () => ({
  // Reports the fallback like the real one, for the pictures named below.
  AuthenticatedImage: ({ alt, onFallbackChange }: { alt: string; onFallbackChange?: (shown: boolean) => void }) => {
    const reports = !!onFallbackChange;
    React.useEffect(() => { if (reports) onFallbackChange?.(fallbackAlts.has(alt)); }, [reports]); // eslint-disable-line react-hooks/exhaustive-deps
    return <img alt={alt} data-fallback={fallbackAlts.has(alt) ? 'true' : undefined} />;
  },
  Skeleton: () => null,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input placeholder={props.placeholder} />,
  Button: ({ children, onClick, type = 'button', disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../FeedbackIdentityModal', () => ({ FeedbackIdentityModal: () => null }));

import { PhotoLightbox } from '../PhotoLightbox';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photos = [1, 2, 3].map((id) => ({
  id, filename: `${id}.jpg`, url: `/api/gallery/g/photo/${id}`, thumbnail_url: `/t/${id}`, type: 'individual',
})) as Photo[];

const STORED = { v: 1, strokes: [{ t: 'arrow', c: 1, p: [[0.2, 0.2], [0.6, 0.7]] }] };
const SETTINGS = {
  feedback_enabled: true, allow_comments: true, allow_annotations: true,
  allow_likes: false, allow_ratings: false, show_feedback_to_guests: true,
};

// jsdom lays nothing out: give the picture a box so the overlay has a
// rectangle to sit on.
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
let queryClient: QueryClient;
function open(settings: Record<string, unknown> = SETTINGS, { panel = true } = {}) {
  vi.mocked(feedbackService.getGalleryFeedbackSettings).mockResolvedValue(settings as never);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PhotoLightbox photos={photos} initialIndex={0} onClose={onClose} slug="g" feedbackEnabled initialShowFeedback={panel} />
    </QueryClientProvider>,
  );
}

const key = (k: string) => act(() => { fireEvent.keyDown(document, { key: k }); });
const counter = (n: number) => screen.getByText(`${n} / 3`);

// The bar's mode switch (item E1): drawing starts from there.
const annotateMode = () => screen.findByRole('radio', { name: 'Annotate' });
const annotateDisabled = () => (screen.getByRole('radio', { name: 'Annotate' }) as HTMLButtonElement).disabled;

async function startDrawing() {
  fireEvent.click(await annotateMode());
  return screen.findByRole('toolbar', { name: 'Drawing tools' });
}

function drag(svg: Element, from: [number, number], to: [number, number]) {
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
  const pointer = (type: string, [x, y]: [number, number]) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.assign(event, { isPrimary: true, pointerId: 1, pointerType: 'mouse' });
    act(() => { fireEvent(svg, event); });
  };
  pointer('pointerdown', from);
  pointer('pointermove', to);
  pointer('pointerup', to);
}

describe('PhotoLightbox — annotate mode (issue 1733)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fallbackAlts.clear();
    vi.mocked(feedbackService.getPhotoFeedback).mockResolvedValue({
      feedback: [], my_feedback: {}, summary: {},
    } as never);
  });

  it('offers no drawing while the gallery has it switched off', async () => {
    open({ ...SETTINGS, allow_annotations: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Comment' }));
    // No mode switch at all: with one mode there is nothing to switch.
    expect(screen.queryByRole('radiogroup', { name: 'Mode' })).toBeNull();
    expect(screen.queryByText('To draw on the photo, switch to Annotate.')).toBeNull();
  });

  // The thumbnail standing in for a picture that did not load can be a
  // crop, so the overlay stays off it: nothing to draw on, no button.
  it('offers no drawing on a photo that shows its fallback thumbnail', async () => {
    fallbackAlts.add('1.jpg');
    open();
    await annotateMode();
    await waitFor(() => expect(annotateDisabled()).toBe(true));

    // The next photo loaded, and it was already mounted as a neighbour.
    key('ArrowRight');
    expect(counter(2)).toBeTruthy();
    await waitFor(() => expect(annotateDisabled()).toBe(false));
    key('ArrowLeft');
    await waitFor(() => expect(annotateDisabled()).toBe(true));
  });

  it('suspends the navigation and zoom keys, and Escape leaves the mode, not the lightbox', async () => {
    open();
    await startDrawing();

    key('ArrowRight');
    key('ArrowLeft');
    expect(counter(1)).toBeTruthy();
    key('+');
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByLabelText('Previous photo').hidden).toBe(true);
    expect(screen.getByLabelText('Next photo').hidden).toBe(true);
    // The close button sits on the photo's corner: out of the way too.
    expect(screen.getByLabelText('Close').hidden).toBe(true);

    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('toolbar', { name: 'Drawing tools' })).toBeNull();

    // Every gesture is back.
    expect(screen.getByLabelText('Close').hidden).toBe(false);
    expect(screen.getByLabelText('Previous photo').hidden).toBe(false);
    key('+');
    expect(screen.getByText('150%')).toBeTruthy();
    key('ArrowRight');
    expect(counter(2)).toBeTruthy();
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('takes the Select actions out of reach while drawing', async () => {
    open();
    // Present before: the role query only finds what a keyboard can reach.
    const toggle = await screen.findByRole('button', { name: 'Toggle feedback' });
    const drawingTools = await startDrawing();

    expect(screen.queryByRole('button', { name: 'Toggle feedback' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
    // Out of the tab order, not unmounted: the colour and decision controls
    // keep their state.
    expect(toggle.isConnected).toBe(true);
    expect(within(drawingTools).getByRole('button', { name: 'Done' })).toBeTruthy();

    key('Escape');
    expect(screen.getByRole('button', { name: 'Toggle feedback' })).toBe(toggle);
  });

  it('does not start a swipe from a touch while drawing', async () => {
    open();
    await startDrawing();
    const track = screen.getByAltText('1.jpg').parentElement!.parentElement!.parentElement!;
    const touch = (x: number) => [{ clientX: x, clientY: 100, identifier: 0, target: track }];
    act(() => { fireEvent.touchStart(track, { touches: touch(300) }); });
    act(() => { fireEvent.touchMove(track, { touches: touch(40) }); });
    act(() => { fireEvent.touchEnd(track, { touches: [], changedTouches: touch(40) }); });
    // The track never left its idle position, and the photo did not change.
    expect(screen.getByAltText('1.jpg').parentElement!.parentElement!.style.transform).toBe('translate3d(-33.3333%, 0, 0)');
    expect(counter(1)).toBeTruthy();
  });

  it('undoes, cancels without saving, and sends the finished drawing with the comment', async () => {
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    open();
    let toolbar = await startDrawing();
    const overlay = () => screen.getByTestId('annotation-overlay');

    drag(overlay(), [40, 20], [200, 100]);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Arrow' }));
    drag(overlay(), [0, 0], [400, 200]);
    expect(overlay().querySelectorAll('path')).toHaveLength(2);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Undo' }));
    expect(overlay().querySelectorAll('path')).toHaveLength(1);

    // Cancel leaves the mode and keeps nothing.
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Drawing attached')).toBeNull();
    expect(screen.queryByTestId('annotation-overlay')).toBeNull();

    toolbar = await startDrawing();
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Arrow' }));
    drag(overlay(), [0, 0], [400, 200]);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Drawing attached')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Write a comment...'), { target: { value: 'Crop here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1));
    expect(feedbackService.submitFeedback).toHaveBeenCalledWith('g', '1', expect.objectContaining({
      feedback_type: 'comment',
      comment_text: 'Crop here',
      annotation: { v: 1, strokes: [{ t: 'arrow', c: 0, p: [[0, 0], [1, 1]] }] },
    }));
    // Sent: the draft is gone from the photo.
    await waitFor(() => expect(screen.queryByTestId('annotation-overlay')).toBeNull());
  });

  it('shows a stored drawing on the photo from the comment list, and only a valid one', async () => {
    vi.mocked(feedbackService.getPhotoFeedback).mockResolvedValue({
      feedback: [
        { id: 7, feedback_type: 'comment', comment_text: 'Look here', annotation: STORED, is_approved: true, is_hidden: false, created_at: '2026-10-01T10:00:00Z' },
        { id: 8, feedback_type: 'comment', comment_text: 'Plain', annotation: null, is_approved: true, is_hidden: false, created_at: '2026-10-01T10:00:00Z' },
        { id: 9, feedback_type: 'comment', comment_text: 'Hostile', annotation: { v: 1, strokes: [{ t: 'free', c: '<script>', p: [[0, 0], [1, 1]] }] }, is_approved: true, is_hidden: false, created_at: '2026-10-01T10:00:00Z' },
      ],
      my_feedback: {}, summary: {},
    } as never);
    open();
    await screen.findByText('Hostile');
    const markers = screen.getAllByRole('button', { name: 'Show drawing' });
    expect(markers).toHaveLength(1);

    fireEvent.click(markers[0]);
    const overlay = screen.getByTestId('annotation-overlay');
    expect(overlay.querySelectorAll('path')).toHaveLength(1);
    expect(overlay.style.pointerEvents).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'Hide drawing' }));
    expect(screen.queryByTestId('annotation-overlay')).toBeNull();
  });

  // A comment's success clears the form and the drawing. The form is one
  // component reused from photo to photo, so a slow response would take a
  // drawing started meanwhile, on this photo or on the next one.
  it('offers no drawing while a comment is still being sent', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(feedbackService.submitFeedback).mockReturnValue(new Promise((resolve) => { finish = resolve; }) as never);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Comment' }));
    fireEvent.change(screen.getByPlaceholderText('Write a comment...'), { target: { value: 'First' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1));
    expect(annotateDisabled()).toBe(true);

    key('ArrowRight');
    expect(counter(2)).toBeTruthy();
    expect(annotateDisabled()).toBe(true);

    await act(async () => { finish({ success: true }); });
    expect(annotateDisabled()).toBe(false);
  });

  // Closing the panel unmounts the form, but its request and that request's
  // success handler live on: reopened, the guest can be drawing again when
  // the earlier comment comes back.
  it('keeps a drawing started after the panel was reopened when an earlier comment finishes sending', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(feedbackService.submitFeedback).mockReturnValue(new Promise((resolve) => { finish = resolve; }) as never);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Comment' }));
    fireEvent.change(screen.getByPlaceholderText('Write a comment...'), { target: { value: 'First' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Toggle feedback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle feedback' }));
    await startDrawing();
    drag(screen.getByTestId('annotation-overlay'), [40, 20], [200, 100]);

    await act(async () => { finish({ success: true }); });
    expect(screen.getByRole('toolbar', { name: 'Drawing tools' })).toBeTruthy();
    expect(screen.getByTestId('annotation-overlay').querySelectorAll('path')).toHaveLength(1);
  });

  // The drawing on the photo is a copy taken when its marker was clicked. A
  // comment the photographer hides meanwhile leaves the list on the next
  // fetch, and its marker with it: the drawing must not stay behind.
  it('takes a shown drawing off the photo when its comment leaves the list', async () => {
    const comment = { id: 7, feedback_type: 'comment', comment_text: 'Look here', annotation: STORED, is_approved: true, is_hidden: false, created_at: '2026-10-01T10:00:00Z' };
    vi.mocked(feedbackService.getPhotoFeedback).mockResolvedValue({ feedback: [comment], my_feedback: {}, summary: {} } as never);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Show drawing' }));
    expect(screen.getByTestId('annotation-overlay')).toBeTruthy();

    // A refetch that still has the comment changes nothing.
    await act(() => queryClient.invalidateQueries({ queryKey: ['photo-feedback'] }));
    expect(screen.getByTestId('annotation-overlay')).toBeTruthy();

    vi.mocked(feedbackService.getPhotoFeedback).mockResolvedValue({ feedback: [], my_feedback: {}, summary: {} } as never);
    await act(() => queryClient.invalidateQueries({ queryKey: ['photo-feedback'] }));
    await waitFor(() => expect(screen.queryByText('Look here')).toBeNull());
    expect(screen.queryByTestId('annotation-overlay')).toBeNull();
  });
});
