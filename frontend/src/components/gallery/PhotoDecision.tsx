import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ThumbsUp, ThumbsDown, MessageSquareText } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  feedbackService,
  DECISION_REASON_MAX_LENGTH,
  type PhotoDecision as Decision,
} from '../../services/feedback.service';
import { Button } from '../common';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';

interface PhotoDecisionProps {
  photoId: string;
  gallerySlug: string;
  /** The guest's current decision, or null. */
  myDecision: Decision | null;
  /** The reason the guest gave, or null. */
  myReason: string | null;
  requireNameEmail?: boolean;
  onDecisionChange?: (decision: Decision | null, reason: string | null) => void;
}

type Submission = { decision: Decision; reason?: string; guest_name?: string; guest_email?: string };

/**
 * Approve / reject one photo (issue 744). The same contract as the colour
 * label beside it: one decision per guest per photo, the same button again
 * clears it, the other one switches. A rejection can carry a short reason for
 * the photographer — sent as the decision again WITH the text, which the
 * backend reads as "edit the reason" rather than as the toggle.
 */
export const PhotoDecision: React.FC<PhotoDecisionProps> = ({
  photoId,
  gallerySlug,
  myDecision,
  myReason,
  requireNameEmail = false,
  onDecisionChange,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const [pending, setPending] = useState<Submission | null>(null);
  const [showReason, setShowReason] = useState(false);
  const [reasonDraft, setReasonDraft] = useState(myReason || '');
  const reasonInputRef = useRef<HTMLTextAreaElement>(null);
  const reasonToggleRef = useRef<HTMLButtonElement>(null);

  // A different photo, or a reason that changed underneath (another tab),
  // starts from what the server holds.
  useEffect(() => {
    setReasonDraft(myReason || '');
  }, [photoId, myReason]);
  useEffect(() => {
    setShowReason(false);
  }, [photoId]);
  // The form exists to be typed into: put the caret there as it opens.
  useEffect(() => {
    if (showReason) reasonInputRef.current?.focus();
  }, [showReason]);

  const mutation = useMutation({
    mutationFn: (data: Submission) => feedbackService.submitFeedback(gallerySlug, photoId, {
      feedback_type: 'decision',
      decision: data.decision,
      // Left out entirely for a button press: an absent reason is what makes
      // the same decision again a toggle.
      ...(data.reason !== undefined ? { comment_text: data.reason } : {}),
      guest_name: data.guest_name || undefined,
      guest_email: data.guest_email || undefined,
    }),
    onMutate: () => {
      setIsSubmitting(true);
      return { previous: myDecision, previousReason: myReason };
    },
    onSuccess: (result, data) => {
      if (result?.removed) {
        onDecisionChange?.(null, null);
      } else if (data.reason !== undefined) {
        onDecisionChange?.(data.decision, data.reason.trim() || null);
        setShowReason(false);
      } else {
        // A switched decision drops the old reason server-side.
        onDecisionChange?.(data.decision, data.decision === myDecision ? myReason : null);
        // Rejecting invites the reason right away; it stays optional.
        if (data.decision === 'rejected') {
          setReasonDraft('');
          setShowReason(true);
        }
      }
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, photoId] });
    },
    onError: (error: unknown) => {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      toast.error(code === 'COMMENT_BLOCKED'
        ? t('feedback.decisionReasonBlocked', 'Your reason contains words that are not allowed here.')
        : t('feedback.decisionError', 'Failed to save your decision'));
    },
    onSettled: () => setIsSubmitting(false),
  });

  const submit = async (data: Submission) => {
    if (isSubmitting) return;
    // Guest identity mode: the server reads name/email from the guest token.
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return; // prompt cancelled
      }
      mutation.mutate(data);
      return;
    }
    if (requireNameEmail && !savedIdentity) {
      setPending(data);
      setShowIdentityModal(true);
      return;
    }
    mutation.mutate({
      ...data,
      ...(savedIdentity ? { guest_name: savedIdentity.name, guest_email: savedIdentity.email } : {}),
    });
  };

  const handleIdentitySubmit = (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    if (pending) {
      mutation.mutate({ ...pending, guest_name: name, guest_email: email });
      setPending(null);
    }
  };

  const buttonClass = (active: boolean, tone: 'approve' | 'reject') => `flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-sm transition-all ${
    active
      ? (tone === 'approve'
        ? 'bg-success text-white ring-1 ring-success'
        : 'bg-danger text-white ring-1 ring-danger')
      : 'bg-white/10 text-white hover:bg-white/20'
  } ${isSubmitting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`;

  const approveLabel = t('feedback.decisionApprove', 'Approve');
  const rejectLabel = t('feedback.decisionReject', 'Reject');

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5" role="group" aria-label={t('feedback.decisionsTitle', 'Approve / reject')}>
        <button
          type="button"
          onClick={() => submit({ decision: 'approved' })}
          disabled={isSubmitting}
          aria-pressed={myDecision === 'approved'}
          aria-label={myDecision === 'approved' ? t('feedback.decisionClear', 'Withdraw your decision') : approveLabel}
          title={approveLabel}
          className={buttonClass(myDecision === 'approved', 'approve')}
        >
          <ThumbsUp className="w-4 h-4" aria-hidden="true" />
          <span className="hidden sm:inline">{approveLabel}</span>
        </button>
        <button
          type="button"
          onClick={() => submit({ decision: 'rejected' })}
          disabled={isSubmitting}
          aria-pressed={myDecision === 'rejected'}
          aria-label={myDecision === 'rejected' ? t('feedback.decisionClear', 'Withdraw your decision') : rejectLabel}
          title={rejectLabel}
          className={buttonClass(myDecision === 'rejected', 'reject')}
        >
          <ThumbsDown className="w-4 h-4" aria-hidden="true" />
          <span className="hidden sm:inline">{rejectLabel}</span>
        </button>
        {myDecision === 'rejected' && (
          <button
            ref={reasonToggleRef}
            type="button"
            onClick={() => setShowReason((open) => !open)}
            aria-expanded={showReason}
            aria-label={t('feedback.decisionReasonEdit', 'Why? (optional)')}
            title={myReason || t('feedback.decisionReasonEdit', 'Why? (optional)')}
            className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <MessageSquareText className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {showReason && myDecision === 'rejected' && (
        <form
          // The toolbar is pinned to the bottom of the lightbox, so on desktop
          // the form opens upward. Phones keep it near the top: the soft
          // keyboard covers the lower half and the toolbar wraps to a height
          // that varies with the enabled buttons.
          className="fixed inset-x-4 top-16 sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:bottom-full sm:mb-2 sm:w-72 p-3 rounded-lg shadow-xl bg-surface border border-border-token z-40 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit({ decision: 'rejected', reason: reasonDraft });
          }}
          // The lightbox's shortcut keys must not fire while typing a reason.
          // Escape closes only this form, not the lightbox behind it.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              setShowReason(false);
              reasonToggleRef.current?.focus();
            }
          }}
        >
          <label className="block text-sm font-medium" style={{ color: 'var(--color-text)' }} htmlFor={`decision-reason-${photoId}`}>
            {t('feedback.decisionReasonLabel', 'Why are you rejecting this photo? (optional)')}
          </label>
          <textarea
            ref={reasonInputRef}
            id={`decision-reason-${photoId}`}
            value={reasonDraft}
            onChange={(e) => setReasonDraft(e.target.value)}
            maxLength={DECISION_REASON_MAX_LENGTH}
            rows={3}
            className="w-full px-2 py-1.5 text-sm rounded border border-border-token bg-transparent"
            style={{ color: 'var(--color-text)' }}
            placeholder={t('feedback.decisionReasonPlaceholder', 'e.g. eyes closed, not my best side')}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowReason(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={isSubmitting}>
              {t('feedback.decisionReasonSave', 'Save reason')}
            </Button>
          </div>
        </form>
      )}

      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPending(null); }}
        onSubmit={handleIdentitySubmit}
        feedbackType={t('feedback.decisionType', 'your decision')}
      />
    </div>
  );
};
