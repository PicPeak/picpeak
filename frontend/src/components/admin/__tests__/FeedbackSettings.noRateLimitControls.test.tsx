/**
 * The card offered a per-event "Enable Rate Limiting" switch with a window and
 * a request cap. None of it was ever saved: the backend drops those keys, and
 * guest feedback is limited by the instance-wide feedback rate limits alone.
 * The controls promised a protection they did not provide, so they are gone.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackSettings } from '../FeedbackSettings';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' },
    }),
  };
});

const settings = {
  feedback_enabled: true,
  allow_ratings: true,
  allow_likes: true,
  allow_comments: true,
  allow_favorites: true,
  allow_reactions: false,
  allow_color_labels: false,
  require_name_email: false,
  moderate_comments: true,
  show_feedback_to_guests: false,
};

describe('FeedbackSettings rate limiting', () => {
  it('offers no per-event rate limit controls', () => {
    render(<FeedbackSettings settings={settings} onChange={vi.fn()} />);

    expect(screen.queryByText('Enable Rate Limiting')).not.toBeInTheDocument();
    expect(screen.queryByText('Time Window (minutes)')).not.toBeInTheDocument();
    expect(screen.queryByText('Max Requests')).not.toBeInTheDocument();
    // The rest of the card still renders.
    expect(screen.getByText('Show Feedback to Guests')).toBeInTheDocument();
  });
});
