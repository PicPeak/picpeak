/**
 * Issue 2043: the carousel's download button spins while the photo is being
 * prepared, ignores activation meanwhile, and keeps a keyboard user's focus.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { gallerySettings: { carouselShowThumbnails: false } } }) }));
vi.mock('../../common', async () => ({
  AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
  // The real button: its loading behaviour is what is under test.
  Button: (await import('../../common/Button')).Button,
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({ feedbackService: { submitFeedback: vi.fn() } }));

import { CarouselGalleryLayout } from '../layouts/CarouselGalleryLayout';
import { beginPhotoDownload, endPhotoDownload } from '../../../hooks/usePhotoDownloadPending';

it('keeps focus on the busy download button and ignores activation', () => {
  const onDownload = vi.fn();
  const photo = { id: 3101, filename: 'p.jpg', url: '/p' } as Photo;
  render(<CarouselGalleryLayout slug="g" onPhotoClick={vi.fn()} onDownload={onDownload} photos={[photo]} />);
  const button = screen.getByTitle('Download photo');
  button.focus();

  let token = 0;
  act(() => { token = beginPhotoDownload(photo.id)!; });
  expect(button).toHaveFocus();
  expect(button).not.toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  fireEvent.click(button);
  expect(onDownload).not.toHaveBeenCalled();

  act(() => endPhotoDownload(photo.id, token));
  fireEvent.click(button);
  expect(onDownload).toHaveBeenCalledTimes(1);
});
