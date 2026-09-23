/**
 * Gallery modal labels follow the gallery theme (#1561 follow-up).
 *
 * The shared Input labels itself neutral-700 with a dark: variant that only
 * the admin dark mode switches, so on a dark gallery theme these labels were
 * dark grey on near-black. The gallery modals pass `themed`.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackIdentityModal } from '../FeedbackIdentityModal';
import { GuestNamePromptModal } from '../GuestNamePromptModal';
import { GuestRecoveryModal } from '../GuestRecoveryModal';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentity: () => ({
    promptOpen: true,
    recoveryOpen: true,
    closePrompt: vi.fn(),
    closeRecovery: vi.fn(),
    register: vi.fn(),
    openRecovery: vi.fn(),
    openPrompt: vi.fn(),
    recoverRequest: vi.fn(),
    recoverVerify: vi.fn(),
  }),
}));

function expectThemedLabels() {
  const labels = Array.from(document.querySelectorAll('label[for]')) as HTMLElement[];
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(label.className).toContain('text-theme');
    expect(label.className).not.toContain('text-neutral-700');
  }
}

describe('gallery modal labels use the theme text token', () => {
  it('FeedbackIdentityModal', () => {
    render(<FeedbackIdentityModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} feedbackType="comment" />);
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
    expectThemedLabels();
  });

  it('GuestNamePromptModal', () => {
    render(<GuestNamePromptModal />);
    expectThemedLabels();
  });

  it('GuestRecoveryModal', () => {
    render(<GuestRecoveryModal />);
    expectThemedLabels();
  });
});
