/**
 * The hero header's fit (issue 2429). It crops to 16:9 at the crop position
 * by default; with the theme's `heroFit: 'contain'` it shows the whole photo
 * from the uncropped preview, and the crop position does not apply.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { HeroHeader } from '../HeroHeader';
import type { Photo } from '../../../types';

let heroFit: 'cover' | 'contain' | undefined;
vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { heroFit, gallerySettings: {} } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: Date) => d.toISOString() }),
}));
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, className, style }: { src: string; className?: string; style?: React.CSSProperties }) => (
    <img data-testid="hero" data-src={src} className={className} style={style} alt="" />
  ),
}));
vi.mock('../HeroDivider', () => ({ HeroDivider: () => null }));

const photo = {
  id: 1,
  filename: 'IMG_1.jpg',
  url: '/api/gallery/x/photo/1',
  hero_url: '/api/gallery/x/hero/1',
  slideshow_url: '/api/gallery/x/preview/1',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
} as Photo;

afterEach(() => cleanup());

describe('HeroHeader fit', () => {
  it('crops the 16:9 hero at the crop position by default', () => {
    heroFit = undefined;
    render(<HeroHeader photos={[photo]} slug="x" heroImageAnchor="50% 20%" />);
    const img = screen.getByTestId('hero');
    expect(img).toHaveAttribute('data-src', '/api/gallery/x/hero/1');
    expect(img).toHaveClass('object-cover');
    expect(img.style.objectPosition).toBe('50% 20%');
  });

  it('shows the whole photo from the uncropped preview', () => {
    heroFit = 'contain';
    render(<HeroHeader photos={[photo]} slug="x" heroImageAnchor="50% 20%" />);
    const img = screen.getByTestId('hero');
    expect(img).toHaveAttribute('data-src', '/api/gallery/x/preview/1');
    expect(img).toHaveClass('object-contain');
    expect(img.style.objectPosition).toBe('');
    expect(img.parentElement).toHaveClass('bg-neutral-900');
  });
});
