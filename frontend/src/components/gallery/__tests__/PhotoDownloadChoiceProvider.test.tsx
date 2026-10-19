/**
 * Download menu for one photo (issue 1733, E2): a gallery that lets guests
 * pick a size asks before a single photo's download starts; with nothing to
 * pick, or for a video, the download starts at once as before.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: {} }));
vi.mock('../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ limited: false, allows: () => true }),
}));
vi.mock('../hooks/useGalleryDialog', () => ({ useGalleryDialog: vi.fn() }));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));

import type { DownloadResolutionChoice, Photo } from '../../../types';
import { useDownloadChoice } from '../../../contexts/DownloadChoiceContext';
import { PhotoDownloadChoiceProvider } from '../PhotoDownloadChoiceProvider';

const ORIGINAL = { id: 'original', label: 'Original', width: null, height: null };
const MEDIUM = { id: '1500x1000', label: 'Medium', width: 1500, height: 1000 };
const photo = { id: 3, filename: 'a.jpg', size: 1000, media_type: 'photo' } as Photo;
const video = { id: 4, filename: 'b.mp4', size: 1000, media_type: 'video' } as Photo;

const Tile: React.FC<{ item: Photo; start: (resolution?: string) => void }> = ({ item, start }) => {
  const { choose } = useDownloadChoice();
  return <button type="button" onClick={() => choose(item, start)}>download {item.filename}</button>;
};

const renderWith = (choices: DownloadResolutionChoice[], item: Photo, start: (resolution?: string) => void) => render(
  <PhotoDownloadChoiceProvider slug="party" choices={choices} watermarked={false}>
    <Tile item={item} start={start} />
  </PhotoDownloadChoiceProvider>,
);

describe('PhotoDownloadChoiceProvider', () => {
  it('asks for a size first and starts the download with the one picked', async () => {
    const start = vi.fn();
    const user = userEvent.setup();
    renderWith([ORIGINAL, MEDIUM], photo, start);
    await user.click(screen.getByRole('button', { name: 'download a.jpg' }));
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^Medium/ }));
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(start).toHaveBeenCalledWith('1500x1000');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling starts nothing', async () => {
    const start = vi.fn();
    const user = userEvent.setup();
    renderWith([ORIGINAL, MEDIUM], photo, start);
    await user.click(screen.getByRole('button', { name: 'download a.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('downloads at once when there is only one size', async () => {
    const start = vi.fn();
    const user = userEvent.setup();
    renderWith([MEDIUM], photo, start);
    await user.click(screen.getByRole('button', { name: 'download a.jpg' }));
    expect(start).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('downloads a video at once: it always ships as uploaded', async () => {
    const start = vi.fn();
    const user = userEvent.setup();
    renderWith([ORIGINAL, MEDIUM], video, start);
    await user.click(screen.getByRole('button', { name: 'download b.mp4' }));
    expect(start).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('downloads a camera RAW at once: the server ships it as stored at any size', async () => {
    const start = vi.fn();
    const user = userEvent.setup();
    const raw = { id: 5, filename: 'evt_5.jpg', original_filename: 'IMG_1.CR2', size: 1000, media_type: 'photo' } as Photo;
    renderWith([ORIGINAL, MEDIUM], raw, start);
    await user.click(screen.getByRole('button', { name: 'download evt_5.jpg' }));
    expect(start).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on body, outside the app root the Premium lightbox makes inert', async () => {
    const user = userEvent.setup();
    const { container } = renderWith([ORIGINAL, MEDIUM], photo, vi.fn());
    await user.click(screen.getByRole('button', { name: 'download a.jpg' }));
    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('opens inside the fullscreen element, the only thing drawn while the Premium lightbox is fullscreen', async () => {
    const user = userEvent.setup();
    const fullscreen = document.createElement('div');
    document.body.appendChild(fullscreen);
    Object.defineProperty(document, 'fullscreenElement', { value: fullscreen, configurable: true });
    try {
      renderWith([ORIGINAL, MEDIUM], photo, vi.fn());
      await user.click(screen.getByRole('button', { name: 'download a.jpg' }));
      expect(fullscreen.contains(screen.getByRole('dialog'))).toBe(true);
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      fullscreen.remove();
    }
  });
});
