import { useCallback } from 'react';
import { feedbackService } from '../services/feedback.service';
import { useGuestIdentityOptional } from '../contexts/GuestIdentityContext';

/**
 * Shared helper used by gallery layout "quick action" buttons (like, favorite,
 * rating, etc.) to submit feedback with proper identity handling:
 *
 *   - In guest identity mode: ensures the visitor has a guest token (prompts
 *     if needed), then submits. Server reads name/email from the token.
 *   - In simple mode with require_name_email: callers still need to show
 *     their own inline FeedbackIdentityModal (we return `needsSimpleIdentity`
 *     to signal this).
 *   - In simple mode without require_name_email: submits directly.
 */
export function useGalleryFeedbackAction() {
  const guestIdentity = useGuestIdentityOptional();

  /**
   * Submit a feedback action. Returns:
   *   - { submitted: true } if the submission happened.
   *   - { cancelled: true } if the user cancelled the guest prompt.
   *   - { needsSimpleIdentity: true } if the caller must show its own legacy
   *     identity modal (simple mode with require_name_email).
   */
  const submit = useCallback(
    async (
      slug: string,
      photoId: number | string,
      action: {
        feedback_type: 'like' | 'favorite' | 'rating' | 'comment';
        rating?: number;
        comment_text?: string;
      },
      options?: {
        requireNameEmail?: boolean;
        savedIdentity?: { name: string; email: string } | null;
      }
    ): Promise<{ submitted?: boolean; cancelled?: boolean; needsSimpleIdentity?: boolean }> => {
      if (guestIdentity?.identityMode === 'guest') {
        try {
          await guestIdentity.ensureIdentity();
        } catch {
          return { cancelled: true };
        }
        await feedbackService.submitFeedback(slug, String(photoId), action);
        return { submitted: true };
      }

      // Simple mode
      if (options?.requireNameEmail && !options.savedIdentity) {
        return { needsSimpleIdentity: true };
      }

      await feedbackService.submitFeedback(slug, String(photoId), {
        ...action,
        guest_name: options?.savedIdentity?.name,
        guest_email: options?.savedIdentity?.email,
      });
      return { submitted: true };
    },
    [guestIdentity]
  );

  return {
    submit,
    isGuestMode: guestIdentity?.identityMode === 'guest',
  };
}
