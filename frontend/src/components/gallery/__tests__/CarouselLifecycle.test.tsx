import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { gallerySettings: { carouselShowThumbnails: false } } }) }));
vi.mock('../../common', () => ({ AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />, Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({ feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}) } }));
import { CarouselGalleryLayout } from '../layouts/CarouselGalleryLayout';
const photo = (id: number) => ({ id, filename: `photo-${id}`, url: '/photo' } as Photo);
it('keeps the carousel usable when a refetch empties, reorders or removes photos', () => {
  const props = { slug: 'g', onPhotoClick: vi.fn(), onDownload: vi.fn(), photos: [] as Photo[] };
  const { rerender } = render(<CarouselGalleryLayout {...props} />);
  rerender(<CarouselGalleryLayout {...props} photos={[photo(1), photo(2)]} />);
  fireEvent.click(screen.getByLabelText('Next photo')); expect(screen.getByAltText('photo-2')).toBeTruthy();
  rerender(<CarouselGalleryLayout {...props} photos={[photo(2), photo(1)]} />); expect(screen.getByAltText('photo-2')).toBeTruthy();
  rerender(<CarouselGalleryLayout {...props} photos={[photo(1)]} />); expect(screen.getByAltText('photo-1')).toBeTruthy();
  rerender(<CarouselGalleryLayout {...props} photos={[]} />);
  rerender(<CarouselGalleryLayout {...props} photos={[photo(3)]} />); expect(screen.getByAltText('photo-3')).toBeTruthy();
});
// The "x selected" counter and "Finish selection" read /my-feedback, which
// only the feedback-change callback refreshes (issue 1733).
it('reports a like to the gallery so the selection counter follows it', async () => {
  const onFeedbackChange = vi.fn();
  render(<CarouselGalleryLayout slug="g" onPhotoClick={vi.fn()} onDownload={vi.fn()} photos={[photo(1), photo(2)]}
    feedbackEnabled feedbackOptions={{ allowLikes: true } as any} onFeedbackChange={onFeedbackChange} />);
  fireEvent.click(screen.getByTitle('Like photo'));
  await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(1));
});
