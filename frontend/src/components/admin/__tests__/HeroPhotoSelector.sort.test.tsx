import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImgHTMLAttributes } from 'react';
import type { AdminPhoto } from '../../../services/photos.service';
import { HeroPhotoSelector } from '../HeroPhotoSelector';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  AuthenticatedImage: (props: ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}));

const photo = (id: number, filename: string, original_filename?: string): AdminPhoto => ({
  id, filename, original_filename, path: `/photos/${id}.jpg`, url: `/photos/${id}.jpg`,
  thumbnail_url: `/thumbnails/${id}.jpg`, type: 'individual', category_id: null,
  category_name: null, category_slug: null, size: 100, uploaded_at: '2026-10-01T00:00:00Z',
});

const pickerNames = () => within(screen.getByRole('dialog')).getAllByRole('img').map((img) => img.getAttribute('alt'));

afterEach(cleanup);

describe('HeroPhotoSelector filename order', () => {
  it('sorts digit runs naturally without changing the Photos tab array', async () => {
    const photos = [
      photo(100, 'IMG_100.jpg'), photo(10, 'IMG_10.jpg'), photo(2, 'IMG_2.jpg'), photo(1, 'IMG_1.jpg'),
    ];
    Object.freeze(photos);
    render(<HeroPhotoSelector photos={photos} onSelect={vi.fn()} isEditing />);
    await userEvent.click(screen.getByRole('button', { name: 'events.selectHeroPhoto' }));

    expect(pickerNames()).toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'IMG_100.jpg']);
    expect(photos.map((p) => p.id)).toEqual([100, 10, 2, 1]);
  });

  it('sorts and labels by camera filename, falling back to the stored filename', async () => {
    const photos = [photo(1, 'a-upload.jpg', 'IMG_10.jpg'), photo(2, 'z-upload.jpg', 'IMG_2.jpg'), photo(3, 'IMG_1.jpg')];
    render(<HeroPhotoSelector photos={photos} onSelect={vi.fn()} isEditing />);
    await userEvent.click(screen.getByRole('button', { name: 'events.selectHeroPhoto' }));

    expect(pickerNames()).toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
    expect(within(screen.getByRole('dialog')).getByText('IMG_2.jpg')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByText('z-upload.jpg')).not.toBeInTheDocument();
  });

  it('breaks equal-name ties by photo id and selects the right photo after sorting', async () => {
    const onSelect = vi.fn();
    render(<HeroPhotoSelector photos={[photo(20, 'IMG_2.jpg'), photo(10, 'IMG_2.jpg')]} onSelect={onSelect} isEditing />);
    await userEvent.click(screen.getByRole('button', { name: 'events.selectHeroPhoto' }));
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('img')[0]);

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(10);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('re-sorts when photos arrive and retains the current hero preview', async () => {
    const props = { onSelect: vi.fn(), currentHeroPhotoId: 10, isEditing: true };
    const { rerender } = render(<HeroPhotoSelector {...props} photos={[photo(10, 'upload.jpg', 'IMG_10.jpg')]} />);
    expect(screen.getByRole('img', { name: 'IMG_10.jpg' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common.change' }));

    rerender(<HeroPhotoSelector {...props} photos={[photo(10, 'upload.jpg', 'IMG_10.jpg'), photo(2, 'IMG_2.jpg')]} />);
    expect(pickerNames()).toEqual(['IMG_2.jpg', 'IMG_10.jpg']);
  });

  it('keeps the empty picker and remove action working', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<HeroPhotoSelector photos={[]} onSelect={onSelect} isEditing />);
    await userEvent.click(screen.getByRole('button', { name: 'events.selectHeroPhoto' }));
    expect(within(screen.getByRole('dialog')).getByText('events.noPhotosAvailable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    rerender(<HeroPhotoSelector photos={[photo(1, 'IMG_1.jpg')]} currentHeroPhotoId={1} onSelect={onSelect} isEditing />);
    await userEvent.click(screen.getByRole('button', { name: 'common.remove' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
  });
});
