import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useIsFetching, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Heart, Lock, X } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button } from '../common';
import { feedbackService } from '../../services/feedback.service';
import type { SelectionState, SubmissionKind } from '../../services/feedback.service';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { FEEDBACK_SUBMITTED_EVENT } from '../../utils/feedbackEvents';
import type { FeedbackSubmittedDetail } from '../../utils/feedbackEvents';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useGalleryDialog } from './hooks/useGalleryDialog';

/**
 * "x of y selected" and the two hand-overs (issue 1733, backlog item A1):
 * "Finish selection" for the guest's picks, and "Approve edited photos" for
 * the sign-off after editing. Each asks for confirmation, because it locks
 * that part of the guest's feedback until the photographer reopens it; once
 * handed in, the bar shows when.
 *
 * The state is the viewer's own (GET /gallery/:slug/selection); `used` is fed
 * from /my-feedback by GalleryView so it follows every like without a request
 * of its own.
 */

export const selectionStateKey = (slug: string) => ['gallery-selection', slug];

/**
 * Keep the counter's source, /my-feedback, in step with every stored like and
 * favourite, whichever layout, lightbox or name dialog sent it: several of
 * them do not call the gallery's feedback-change callback.
 */
export function useSelectionPickRefresh(slug: string, enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return undefined;
    const onSubmitted = (event: Event) => {
      const detail = (event as CustomEvent<FeedbackSubmittedDetail>).detail;
      if (detail?.slug !== slug) return;
      if (detail.feedback_type !== 'like' && detail.feedback_type !== 'favorite') return;
      queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
    };
    window.addEventListener(FEEDBACK_SUBMITTED_EVENT, onSubmitted);
    return () => window.removeEventListener(FEEDBACK_SUBMITTED_EVENT, onSubmitted);
  }, [queryClient, slug, enabled]);
}

interface SelectionSubmitBarProps {
  slug: string;
  state: SelectionState | undefined;
  /** How many photos the viewer has picked. */
  used: number;
  className?: string;
}

export const SelectionSubmitBar: React.FC<SelectionSubmitBarProps> = ({ slug, state, used, className = '' }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [confirming, setConfirming] = useState<SubmissionKind | null>(null);
  const [note, setNote] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const mutation = useMutation({
    mutationFn: async (kind: SubmissionKind) => {
      // Guest identity mode: the submission belongs to the registered guest.
      if (guestIdentity?.identityMode === 'guest') await guestIdentity.ensureIdentity();
      return feedbackService.submitSelection(slug, kind, note.trim());
    },
    onSuccess: (_submission, kind) => {
      toast.success(kind === 'approval'
        ? t('gallery.selection.approveSuccess', 'Your approval was sent to the photographer')
        : t('gallery.selection.finishSuccess', 'Your selection was sent to the photographer'));
      setConfirming(null);
      setNote('');
    },
    onError: (error: unknown) => {
      // A cancelled name prompt is not a failure; a request that never got an
      // answer (offline, timed out) is, and is told like any other.
      if ((error as Error)?.message === 'user_cancelled') return;
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'ALREADY_SUBMITTED') {
        setConfirming(null);
        return;
      }
      toast.error(code === 'NOTHING_SELECTED'
        ? t('gallery.selection.nothingSelected', 'Select at least one photo first')
        : code === 'COMMENT_BLOCKED'
          ? t('gallery.selection.noteBlocked', 'Your note contains words that are not allowed here.')
          : t('gallery.selection.submitError', 'Could not send it. Please try again.'));
    },
    // Whatever happened, the server knows the state.
    onSettled: () => queryClient.invalidateQueries({ queryKey: selectionStateKey(slug) }),
  });

  // The dialog names the counts and warns about rejected photos. Opening it
  // asks the server again, and until that answer is in, the numbers on show
  // may predate the guest's last decisions: nothing is confirmed on them.
  // The pick count comes from /my-feedback, so that is asked again as well.
  const refreshing = useIsFetching({ queryKey: selectionStateKey(slug) })
    + useIsFetching({ queryKey: ['my-feedback', slug] }) > 0;

  const closeDialog = () => {
    if (!mutation.isPending) setConfirming(null);
  };
  useGalleryDialog({ open: confirming !== null, onClose: closeDialog, panelRef, initialFocusRef: cancelRef });

  if (!state) return null;
  const { selection, approval } = state;
  if (!selection.counter && !approval.can_submit) return null;

  const openDialog = async (kind: SubmissionKind) => {
    // Guest identity mode: the submission belongs to the registered guest, so
    // the name is asked for before this dialog opens. The name prompt sits
    // below it (z-[60] against z-[9999]): opened from the confirm button it
    // was covered, and the dialog waited on an answer nobody could give.
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
    }
    setNote('');
    setConfirming(kind);
    // The dialog names the counts; make sure they are the server's.
    queryClient.invalidateQueries({ queryKey: selectionStateKey(slug) });
    queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
  };

  const isApproval = confirming === 'approval';
  const dialogTitle = isApproval
    ? t('gallery.selection.approveTitle', 'Approve the edited photos?')
    : t('gallery.selection.finishTitle', 'Finish your selection?');

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-token bg-surface text-theme px-4 py-3 ${className}`}
      data-testid="selection-submit-bar"
    >
      {selection.counter && (
        <span className="inline-flex items-center gap-2 text-sm font-medium" data-testid="selection-counter">
          <Heart className="w-4 h-4 shrink-0" aria-hidden="true" />
          {selection.cap !== null
            ? t('gallery.selection.counterCapped', '{{used}} of {{cap}} selected', { used, cap: selection.cap })
            : t('gallery.selection.counter', '{{used}} selected', { used })}
        </span>
      )}

      {selection.can_submit && (selection.submission ? (
        <span className="inline-flex items-center gap-2 text-sm text-muted-theme" data-testid="selection-submitted">
          <Lock className="w-4 h-4 shrink-0" aria-hidden="true" />
          {t('gallery.selection.finishedOn', 'Selection finished on {{date}}. Your picks are locked.', {
            date: format(selection.submission.submitted_at),
          })}
        </span>
      ) : (
        <Button variant="primary" size="sm" disabled={used === 0} onClick={() => openDialog('selection')}>
          {t('gallery.selection.finish', 'Finish selection')}
        </Button>
      ))}

      {approval.can_submit && (approval.submission ? (
        <span className="inline-flex items-center gap-2 text-sm text-muted-theme" data-testid="approval-submitted">
          <CheckCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {t('gallery.selection.approvedOn', 'Edited photos approved on {{date}}', {
            date: format(approval.submission.submitted_at),
          })}
        </span>
      ) : (
        <Button
          variant={selection.can_submit && !selection.submission ? 'outline' : 'primary'}
          size="sm"
          leftIcon={<CheckCircle className="w-4 h-4" />}
          onClick={() => openDialog('approval')}
        >
          {t('gallery.selection.approve', 'Approve edited photos')}
        </Button>
      ))}

      {/* Portalled: in the full-bleed layouts this bar sits in a band with a
          stacking context of its own. */}
      {confirming && createPortal(
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
          onClick={closeDialog}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={dialogTitle}
            className="card-themed text-theme p-6 max-w-md w-full"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <h2 className="text-lg font-semibold text-theme">{dialogTitle}</h2>
              <button
                type="button"
                onClick={closeDialog}
                aria-label={t('common.close', 'Close')}
                className="text-muted-theme hover:text-theme"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isApproval ? (
              <>
                <p className="text-sm text-theme">
                  {t('gallery.selection.approveBody', 'You confirm that the edited photos are fine as they are and the photographer can go ahead. After that you can no longer change your approvals and rejections; the photographer can reopen them for you.')}
                </p>
                {approval.rejected > 0 && (
                  <p className="mt-2 text-sm text-status hue-warning">
                    {t('gallery.selection.approveRejected', 'Photos still marked as rejected: {{count}}', { count: approval.rejected })}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-theme mb-1" data-testid="selection-finish-count">
                  {t('gallery.selection.finishCount', 'Selected photos: {{count}}', { count: used })}
                </p>
                <p className="text-sm text-muted-theme">
                  {t('gallery.selection.finishBody', 'Your selection goes to the photographer. After that you can no longer change it; the photographer can reopen it for you.')}
                </p>
              </>
            )}

            <label className="block mt-4 text-sm text-theme" htmlFor="selection-submit-note">
              {t('gallery.selection.noteLabel', 'Note for the photographer (optional)')}
            </label>
            <textarea
              id="selection-submit-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              rows={3}
              className="mt-1 w-full p-3 rounded-lg border border-border-token bg-elevated text-theme text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent"
            />

            <div className="mt-4 flex justify-end gap-2">
              <Button ref={cancelRef} variant="outline" size="sm" onClick={closeDialog} disabled={mutation.isPending}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isLoading={mutation.isPending}
                disabled={refreshing}
                onClick={() => mutation.mutate(confirming)}
              >
                {isApproval
                  ? t('gallery.selection.approveConfirm', 'Approve')
                  : t('gallery.selection.finish', 'Finish selection')}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
