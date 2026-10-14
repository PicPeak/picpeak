/**
 * The lightbox's keys stay out of fields and dialogs (issue 1973).
 *
 * The document-level handler paged, zoomed, downloaded and closed on any
 * keydown: the arrows moving the caret in the comment field changed the
 * photo, and Escape in the name-and-e-mail prompt closed the lightbox under
 * it. Keys from a field, and every key while a dialog is open on top, are
 * now left alone.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({
      feedback_enabled: true, allow_ratings: false, allow_likes: true, allow_comments: false, require_name_email: true,
    }),
    getPhotoFeedback: vi.fn().mockResolvedValue({ feedback: [], my_feedback: {}, summary: {} }),
    submitFeedback: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
// The real Button and Input: the identity prompt below is the real one.
vi.mock('../../common', async () => ({
  Button: (await import('../../common/Button')).Button,
  Input: (await import('../../common/Input')).Input,
  AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { PhotoLightbox } from '../PhotoLightbox';
import { FeedbackLimitReachedModal } from '../FeedbackLimitReachedModal';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photos = [10, 11, 12].map((id) => ({ id, filename: `${id}.jpg`, url: `/p/${id}`, thumbnail_url: `/t/${id}`, type: 'individual' } as Photo));

function renderLightbox() {
  const onClose = vi.fn();
  const onCurrentPhotoChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PhotoLightbox photos={photos} initialIndex={1} onClose={onClose} slug="g" feedbackEnabled onCurrentPhotoChange={(id) => onCurrentPhotoChange(id)} />
    </QueryClientProvider>,
  );
  return { onClose, onCurrentPhotoChange };
}

describe('PhotoLightbox keys (issue 1973)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('pages and closes on keys pressed outside a field', () => {
    const { onClose, onCurrentPhotoChange } = renderLightbox();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onCurrentPhotoChange).toHaveBeenLastCalledWith(12);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores the arrows, Escape, +, - and d typed into a field', () => {
    const { onClose, onCurrentPhotoChange } = renderLightbox();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    try {
      for (const key of ['ArrowRight', 'ArrowLeft', 'Escape', '+', '-', 'd']) {
        fireEvent.keyDown(field, { key });
      }
    } finally {
      field.remove();
    }
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(1); // the opening photo only
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves the keys to the identity prompt while it is open on top', async () => {
    const { onClose, onCurrentPhotoChange } = renderLightbox();
    fireEvent.click(await screen.findByRole('button', { name: /^like photo$/i }));
    const dialog = await screen.findByRole('dialog');

    // Pressed on the dialog, not in a field: the photo the prompt is about
    // stays on screen.
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(1);

    // Escape closes the prompt, not the lightbox under it.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // With the prompt gone the lightbox has its keys back.
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onCurrentPhotoChange).toHaveBeenLastCalledWith(12);
  });

  it('leaves Escape to the feedback limit notice open on top', () => {
    const { onClose, onCurrentPhotoChange } = renderLightbox();
    const closeNotice = vi.fn();
    render(<FeedbackLimitReachedModal open feedbackType="like" limit={3} currentCount={3} onClose={closeNotice} />);
    const dialog = screen.getByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(closeNotice).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(1);
  });

  it('stays under a dialog that was already open when it mounted', () => {
    // Browser Forward reopens a photo while a page dialog painted above the
    // lightbox (the guest name prompt, a notice) is still up.
    const closeNotice = vi.fn();
    const notice = <FeedbackLimitReachedModal open feedbackType="like" limit={3} currentCount={3} onClose={closeNotice} />;
    const onClose = vi.fn();
    const onCurrentPhotoChange = vi.fn();
    const client = new QueryClient();
    const view = (withLightbox: boolean) => (
      <QueryClientProvider client={client}>
        {notice}
        {withLightbox && <PhotoLightbox photos={photos} initialIndex={1} onClose={onClose} slug="g" onCurrentPhotoChange={(id) => onCurrentPhotoChange(id)} />}
      </QueryClientProvider>
    );
    const { rerender } = render(view(false));
    rerender(view(true));
    const dialog = screen.getByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(closeNotice).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(1); // the opening photo only
  });
});
