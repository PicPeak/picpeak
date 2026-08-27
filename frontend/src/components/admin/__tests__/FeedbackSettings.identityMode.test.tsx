/**
 * The identity-mode chooser, and the third option added for #1197.
 *
 * The shared colour tag is the one mode where a guest can overwrite another
 * guest's mark and where the admin loses attribution, so the consequences are
 * spelled out in the panel rather than left to the release notes. These tests
 * pin that the option exists, that picking it reports the right value, and
 * that the warning is tied to the selection rather than always on.
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
      t: (_key: string, fallback?: any) =>
        typeof fallback === 'string' ? fallback : _key,
      i18n: { language: 'en' }
    })
  };
});

const baseSettings = {
  feedback_enabled: true,
  allow_ratings: true,
  allow_likes: true,
  allow_comments: true,
  allow_favorites: true,
  allow_reactions: true,
  allow_color_labels: true,
  require_name_email: false,
  moderate_comments: false,
  show_feedback_to_guests: true,
  enable_rate_limiting: false,
};

const renderPanel = (overrides = {}) => {
  const onChange = vi.fn();
  render(
    <FeedbackSettings
      settings={{ ...baseSettings, ...overrides } as any}
      onChange={onChange}
    />
  );
  return { onChange };
};

describe('identity mode chooser', () => {
  it('offers all three modes', () => {
    renderPanel();
    expect(screen.getByRole('radio', { name: /Simple feedback/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Per-guest selections/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /One shared colour tag/i })).toBeInTheDocument();
  });

  it('reports the shared mode when it is picked', async () => {
    const { onChange } = renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: /One shared colour tag/i }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ identity_mode: 'shared' })
    );
  });

  it('says out loud that the colour tag loses its author', () => {
    renderPanel({ identity_mode: 'shared' });
    // Attribution disappearing is the point of the mode, not a bug — but an
    // operator has to meet that fact before they pick it, not after.
    expect(screen.getByText(/cannot show who set one/i)).toBeInTheDocument();
  });

  it('promises the existing per-visitor labels survive the switch', () => {
    renderPanel({ identity_mode: 'shared' });
    expect(screen.getByText(/come back if you switch away/i)).toBeInTheDocument();
  });

  it('keeps the warning out of the way in the other modes', () => {
    renderPanel({ identity_mode: 'guest' });
    expect(screen.queryByText(/cannot show who set one/i)).not.toBeInTheDocument();
  });

  it('marks only the selected mode as checked', () => {
    renderPanel({ identity_mode: 'shared' });
    expect(screen.getByRole('radio', { name: /One shared colour tag/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Simple feedback/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Per-guest selections/i })).not.toBeChecked();
  });
});
