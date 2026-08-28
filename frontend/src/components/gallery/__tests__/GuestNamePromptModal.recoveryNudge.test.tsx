/**
 * The returning-guest nudge on the registration form (#1210).
 *
 * A guest who fills this form in again becomes a second gallery_guests row and
 * their earlier likes and favourites stop counting as theirs. Recovery has
 * always been here to prevent exactly that — as a small link under the submit
 * button, which people read as fine print and skipped, so duplicates kept
 * accumulating even for guests who had given an email the first time.
 *
 * These pin that it is findable and that it routes into recovery rather than
 * registering. What they deliberately do NOT pin is any check against the
 * typed email: asking the server whether an address is already registered
 * would answer "is this person in this gallery" to anyone who asked.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { GuestNamePromptModal } from '../GuestNamePromptModal';

const closePrompt = vi.fn();
const openRecovery = vi.fn();
const register = vi.fn();

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' }
    })
  };
});

vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentity: () => ({
    promptOpen: true,
    closePrompt,
    register,
    openRecovery,
  }),
}));

describe('returning-guest nudge (#1210)', () => {
  beforeEach(() => {
    closePrompt.mockReset();
    openRecovery.mockReset();
    register.mockReset();
  });

  it('tells the guest their earlier picks still exist', () => {
    render(<GuestNamePromptModal />);
    // Worded around what they lose by missing it. "I've been here before"
    // reads as a greeting; this reads as a reason to stop and click.
    expect(screen.getByText(/your earlier picks are still saved/i)).toBeInTheDocument();
  });

  it('routes into recovery instead of registering a second time', async () => {
    render(<GuestNamePromptModal />);

    await userEvent.click(screen.getByRole('button', { name: /get them back/i }));

    expect(openRecovery).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });

  it('leaves the ordinary registration path alone', async () => {
    render(<GuestNamePromptModal />);

    await userEvent.type(screen.getByLabelText(/your name/i), 'Tina');
    await userEvent.click(screen.getByRole('button', { name: /^Continue$/i }));

    // A first-time guest still just registers — the nudge is an offer beside
    // the form, not a step in front of it.
    expect(register).toHaveBeenCalled();
    expect(openRecovery).not.toHaveBeenCalled();
  });
});
