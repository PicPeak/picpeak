import { toast } from 'react-toastify';
import i18n from 'i18next';

/**
 * A finished selection or approval locks the feedback it covers (issue 1733):
 * the server answers a like, favourite or approve / reject with 409 and
 * `SELECTION_LOCKED` / `APPROVAL_LOCKED` until the photographer reopens it.
 */
export function feedbackLockKind(error: unknown): 'selection' | 'approval' | null {
  const response = (error as { response?: { status?: number; data?: { code?: string } } })?.response;
  if (response?.status !== 409) return null;
  if (response.data?.code === 'SELECTION_LOCKED') return 'selection';
  if (response.data?.code === 'APPROVAL_LOCKED') return 'approval';
  return null;
}

/** Tell the guest why their click did nothing. True when it was a lock. */
export function explainFeedbackLock(error: unknown): boolean {
  const kind = feedbackLockKind(error);
  if (!kind) return false;
  toast.info(
    kind === 'approval'
      ? i18n.t('gallery.selection.lockedApproval', 'You approved the edited photos, so your approvals and rejections can no longer be changed. Ask the photographer to reopen them.')
      : i18n.t('gallery.selection.lockedSelection', 'Your selection is finished and can no longer be changed. Ask the photographer to reopen it.'),
    // One notice, however many tiles were clicked.
    { toastId: `feedback-locked-${kind}` },
  );
  return true;
}
