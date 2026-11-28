/**
 * The nav heart the three full-page layouts share: the gallery's "Liked"
 * filter with the viewer's own count. Each layout brings its classes and its
 * hover text; the behaviour is one.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { LikedNavButton } from '../LikedNavButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));

const mount = (props: Partial<React.ComponentProps<typeof LikedNavButton>> = {}) => render(
  <LikedNavButton
    className="nav-btn"
    activeClassName="is-on"
    countClassName="count"
    iconClassName="w-4 h-4"
    title="Favorites"
    testId="x-nav-liked"
    likedOnly={false}
    likedCount={0}
    onToggleLikedOnly={() => {}}
    {...props}
  />,
);

describe('LikedNavButton', () => {
  it('toggles the gallery\'s Liked filter and says whether it is on', () => {
    const onToggleLikedOnly = vi.fn();
    const { rerender } = mount({ onToggleLikedOnly });
    const heart = screen.getByTestId('x-nav-liked');
    expect(heart).toHaveAttribute('aria-pressed', 'false');
    expect(heart).toHaveClass('nav-btn');
    expect(heart).not.toHaveClass('is-on');
    fireEvent.click(heart);
    expect(onToggleLikedOnly).toHaveBeenCalledTimes(1);

    rerender(
      <LikedNavButton className="nav-btn" activeClassName="is-on" countClassName="count" iconClassName="w-4 h-4"
        title="Favorites" testId="x-nav-liked" likedOnly likedCount={0} onToggleLikedOnly={onToggleLikedOnly} />,
    );
    expect(heart).toHaveAttribute('aria-pressed', 'true');
    expect(heart).toHaveClass('is-on');
    expect(heart.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });

  it('counts the viewer\'s likes, in its name exactly and on the badge up to nine', () => {
    mount({ likedCount: 3 });
    expect(screen.getByRole('button', { name: 'Show only photos I liked (3)' })).toHaveTextContent('3');
    mount({ likedCount: 12, testId: 'y-nav-liked' });
    expect(screen.getByRole('button', { name: 'Show only photos I liked (12)' })).toHaveTextContent('9+');
  });

  it('shows no badge without likes and takes the layout\'s hover text', () => {
    mount({ title: 'Show only photos I liked' });
    const heart = screen.getByTestId('x-nav-liked');
    expect(heart.querySelector('.count')).toBeNull();
    expect(heart).toHaveAttribute('title', 'Show only photos I liked');
  });

  it('is the control focus returns to from an emptied Liked view, and no filter without a handler', () => {
    mount({ onToggleLikedOnly: undefined });
    const heart = screen.getByTestId('x-nav-liked');
    expect(heart).toHaveAttribute('data-gallery-focus', 'liked');
    expect(heart).not.toHaveAttribute('aria-pressed');
  });
});
