/**
 * A gallery from a booking that waits for full payment (#2440) keeps the
 * visitor's session like a paused one, but says why it is closed.
 */
import { render, screen } from '@testing-library/react';
import { GalleryUnavailableNotice } from '../GalleryUnavailableNotice';
import { galleryClosedReason, isGalleryTemporarilyDisabled } from '../../../utils/galleryAvailability';

const error = (code: string) => ({ response: { status: 403, data: { code } } });

test('awaiting payment counts as closed-for-now and gets its own notice', () => {
  expect(isGalleryTemporarilyDisabled(error('GALLERY_AWAITING_PAYMENT'))).toBe(true);
  expect(galleryClosedReason(error('GALLERY_AWAITING_PAYMENT'))).toBe('payment');
  render(<GalleryUnavailableNotice error={error('GALLERY_AWAITING_PAYMENT')} />);
  expect(screen.getByRole('status')).toHaveTextContent(/invoice is paid/i);
});

test('a paused gallery keeps the paused notice', () => {
  expect(galleryClosedReason(error('GALLERY_TEMPORARILY_DISABLED'))).toBe('paused');
  render(<GalleryUnavailableNotice error={error('GALLERY_TEMPORARILY_DISABLED')} />);
  expect(screen.getByRole('status')).not.toHaveTextContent(/invoice is paid/i);
});
