/**
 * The per-gallery switch for named favourite lists (issue 2303): off unless
 * switched on, reported as allow_favorite_lists, and only available while
 * favourites themselves are on.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackSettings } from '../FeedbackSettings';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' },
    }),
  };
});

const baseSettings = {
  feedback_enabled: true,
  allow_ratings: true,
  allow_likes: true,
  allow_comments: true,
  allow_favorites: true,
  allow_reactions: true,
  allow_color_labels: false,
  require_name_email: false,
  moderate_comments: false,
  show_feedback_to_guests: true,
};

const renderPanel = (overrides = {}) => {
  const onChange = vi.fn();
  render(<FeedbackSettings settings={{ ...baseSettings, ...overrides }} onChange={onChange} />);
  return { onChange, toggle: () => screen.getByRole('checkbox', { name: /Favorite lists/i }) };
};

describe('favourite lists toggle (issue 2303)', () => {
  it('is off for a gallery that never set it', () => {
    const { toggle } = renderPanel();
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toBeEnabled();
  });

  it('reports allow_favorite_lists when switched on', async () => {
    const { onChange, toggle } = renderPanel();
    await userEvent.click(toggle());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ allow_favorite_lists: true }));
  });

  it('shows the stored state and cannot be changed while favourites are off', async () => {
    const { onChange, toggle } = renderPanel({ allow_favorites: false, allow_favorite_lists: true });
    expect(toggle()).toBeChecked();
    expect(toggle()).toBeDisabled();
    await userEvent.click(toggle());
    expect(onChange).not.toHaveBeenCalled();
  });
});
