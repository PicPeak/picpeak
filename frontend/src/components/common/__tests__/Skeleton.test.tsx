import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Skeleton, SkeletonGalleryGrid, SkeletonCard } from '../Skeleton';

/**
 * Regression for #358. The Skeleton placeholders used to hard-code
 * `bg-neutral-200`, which rendered as bright light grey on dark
 * gallery themes (Rekoo-PS's "most annoying" frame). They must instead
 * use the active theme's surface-border colour so the placeholders
 * track whatever the theme defines for both light and dark modes.
 */
describe('Skeleton — theme-aware colour', () => {
  it('uses var(--color-surface-border) for the placeholder background', () => {
    const { container } = render(<Skeleton />);
    const div = container.querySelector('div');
    expect(div).not.toBeNull();
    expect(div!.style.backgroundColor).toBe('var(--color-surface-border, #e5e5e5)');
  });

  it('does NOT add the legacy hard-coded bg-neutral-200 class', () => {
    const { container } = render(<Skeleton />);
    const div = container.querySelector('div');
    expect(div!.className).not.toMatch(/bg-neutral-200/);
  });

  it('SkeletonGalleryGrid tiles inherit the theme colour', () => {
    const { container } = render(<SkeletonGalleryGrid count={3} />);
    // Tiles are the Skeleton components — direct children of the
    // gallery-grid wrapper. They carry aria-busy="true" while the
    // wrapper does not, which is the cleanest way to select them.
    const tiles = container.querySelectorAll('[aria-busy="true"]');
    expect(tiles.length).toBe(3);
    tiles.forEach((tile) => {
      expect((tile as HTMLElement).style.backgroundColor).toBe(
        'var(--color-surface-border, #e5e5e5)'
      );
    });
  });

  it('SkeletonCard surface uses var(--color-surface)', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.style.backgroundColor).toBe('var(--color-surface, #ffffff)');
    // Sanity: should not retain the old bg-white class either
    expect(card.className).not.toMatch(/bg-white/);
  });
});
