/**
 * Issue 2043: the Premium lightbox's download button spins while the photo
 * on screen is being prepared.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import Lightbox from 'yet-another-react-lightbox';
import Download from 'yet-another-react-lightbox/plugins/download';

import { PremiumLightboxDownloadButton } from '../PremiumLightboxDownloadButton';
import { beginPhotoDownload, endPhotoDownload } from '../../../../hooks/usePhotoDownloadPending';

function renderLightbox(onDownload = vi.fn()) {
  render(
    <Lightbox
      open
      slides={[{ src: '/p/901.jpg', photoId: 901 } as never]}
      plugins={[Download]}
      render={{ buttonDownload: () => <PremiumLightboxDownloadButton onDownload={onDownload} /> }}
    />,
  );
  return onDownload;
}

describe('PremiumLightboxDownloadButton (issue 2043)', () => {
  afterEach(() => endPhotoDownload(901));

  it('shows the plugin glyph and hands the slide over on a tap', () => {
    const onDownload = renderLightbox();
    const button = screen.getByRole('button', { name: 'Download' });
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button.querySelector('.animate-spin')).toBeNull();
    button.click();
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ photoId: 901 }));
  });

  it('spins while the photo is being prepared', () => {
    beginPhotoDownload(901);
    renderLightbox();
    const button = screen.getByRole('button', { name: 'Preparing your download…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('.animate-spin')).not.toBeNull();
  });
});
