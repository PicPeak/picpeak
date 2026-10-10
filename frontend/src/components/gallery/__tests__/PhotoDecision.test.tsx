/**
 * Approve / reject one photo (issue 744).
 *
 * A button press sends the decision WITHOUT a reason — that absence is what
 * lets the backend read the same decision again as "clear it". Saving a reason
 * sends the decision WITH the text, which the backend reads as an edit.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { PhotoDecision } from '../PhotoDecision';
import { FeedbackSettings } from '../../admin/FeedbackSettings';
import { ColorLabelBadge } from '../ColorLabelBadge';

const submitFeedback = vi.fn();

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

vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<any>('../../../services/feedback.service');
  return {
    ...actual,
    feedbackService: { submitFeedback: (...args: any[]) => submitFeedback(...args) }
  };
});

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const renderDecision = (myDecision: 'approved' | 'rejected' | null, myReason: string | null = null) => {
  const onDecisionChange = vi.fn();
  render(
    <PhotoDecision
      gallerySlug="g"
      photoId="1"
      myDecision={myDecision}
      myReason={myReason}
      onDecisionChange={onDecisionChange}
    />,
    { wrapper }
  );
  return { onDecisionChange };
};

describe('PhotoDecision (issue 744)', () => {
  beforeEach(() => submitFeedback.mockReset());

  it('approves without sending a reason', async () => {
    submitFeedback.mockResolvedValue({ success: true, created: true });
    const { onDecisionChange } = renderDecision(null);

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(onDecisionChange).toHaveBeenCalledWith('approved', null));
    const payload = submitFeedback.mock.calls[0][2];
    expect(payload).toMatchObject({ feedback_type: 'decision', decision: 'approved' });
    expect(payload).not.toHaveProperty('comment_text');
  });

  it('clears when the server says the same decision toggled off', async () => {
    submitFeedback.mockResolvedValue({ success: true, removed: true });
    const { onDecisionChange } = renderDecision('approved');

    const approve = screen.getByRole('button', { name: 'Withdraw your decision' });
    expect(approve).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(approve);

    await waitFor(() => expect(onDecisionChange).toHaveBeenCalledWith(null, null));
  });

  it('saves a reason as an edit of the rejection', async () => {
    submitFeedback.mockResolvedValue({ success: true, updated: true });
    const { onDecisionChange } = renderDecision('rejected');

    await userEvent.click(screen.getByRole('button', { name: 'Why? (optional)' }));
    await userEvent.type(screen.getByRole('textbox'), 'Eyes closed');
    await userEvent.click(screen.getByRole('button', { name: 'Save reason' }));

    await waitFor(() => expect(onDecisionChange).toHaveBeenCalledWith('rejected', 'Eyes closed'));
    expect(submitFeedback.mock.calls[0][2]).toMatchObject({
      feedback_type: 'decision', decision: 'rejected', comment_text: 'Eyes closed',
    });
  });
  it('focuses the reason field as the form opens', async () => {
    renderDecision('rejected');

    await userEvent.click(screen.getByRole('button', { name: 'Why? (optional)' }));

    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('closes the reason form on Escape without letting the key reach the lightbox', async () => {
    const lightboxKeydown = vi.fn();
    document.addEventListener('keydown', lightboxKeydown);
    try {
      renderDecision('rejected');
      const toggle = screen.getByRole('button', { name: 'Why? (optional)' });
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveFocus();
      expect(lightboxKeydown).not.toHaveBeenCalled();
      expect(submitFeedback).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', lightboxKeydown);
    }
  });

  it('keeps typed keys away from the lightbox shortcuts', async () => {
    const lightboxKeydown = vi.fn();
    document.addEventListener('keydown', lightboxKeydown);
    try {
      renderDecision('rejected');
      await userEvent.click(screen.getByRole('button', { name: 'Why? (optional)' }));
      lightboxKeydown.mockClear();

      await userEvent.keyboard('ab');

      expect(screen.getByRole('textbox')).toHaveValue('ab');
      expect(lightboxKeydown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', lightboxKeydown);
    }
  });
});

describe('decision surfaces (issue 744)', () => {
  it('offers the per-event toggle, off when the setting is absent', async () => {
    const onChange = vi.fn();
    const settings = {
      feedback_enabled: true, allow_ratings: true, allow_likes: true, allow_comments: true,
      allow_favorites: true, allow_reactions: false, allow_color_labels: false,
      require_name_email: false, moderate_comments: true, show_feedback_to_guests: false,
    };
    render(<FeedbackSettings settings={settings} onChange={onChange} />);

    const toggle = screen.getByText('Approve / reject per photo').closest('label')!.querySelector('input')!;
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ allow_decisions: true }));
  });

  it("marks the viewer's own decision on the tile", () => {
    render(<ColorLabelBadge colorLabel={null} decision="rejected" />);
    expect(screen.getByLabelText('You rejected this photo')).toBeInTheDocument();
  });
});
