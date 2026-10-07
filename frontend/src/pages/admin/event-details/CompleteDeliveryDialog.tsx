/**
 * "Full gallery is ready" (issue 1562).
 *
 * Completing is always a deliberate action — never "count reached" or "date
 * passed", either of which would announce an unfinished gallery. The dialog
 * says what changes for the guest, offers the "your complete gallery is
 * ready" mail (on by default), and offers to remove first-look photos that
 * arrived again in the full set under the same original filename; without
 * that the customer sees those shots twice. The badge moves onto the full-set
 * copies server-side either way.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { CheckCircle2, X } from 'lucide-react';
import { Button } from '../../../components/common';
import { eventsService, type DeliveryState } from '../../../services/events.service';
import { photosService } from '../../../services/photos.service';
import { usePermission } from '../../../hooks/usePermission';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { GalleryRecipientsList } from '../../../components/admin/GalleryRecipientsList';
import type { Event } from '../../../types';
import { accountsAnnounceable, eventNotice, useAccountReach } from './OverviewTab';

interface CompleteDeliveryDialogProps {
  /** The gallery; the dialog lists who the mail goes to. */
  event: Event;
  state: DeliveryState;
  isOpen: boolean;
  onClose: () => void;
  onCompleted: () => void;
}

export const CompleteDeliveryDialog: React.FC<CompleteDeliveryDialogProps> = ({ event, state, isOpen, onClose, onCompleted }) => {
  const { t } = useTranslation();
  const eventId = event.id;
  // Exactly whom galleryNotificationService.notifyGalleryCompleted mails: no
  // account for a draft, archived or expired gallery, and one person in both
  // fields gets the portal version.
  const reach = useAccountReach();
  const notice = eventNotice(event, reach, { preferPortal: true, accountsAnnounced: accountsAnnounceable(event) });
  const queryClient = useQueryClient();
  const canDelete = usePermission('photos.delete');
  const [sendEmail, setSendEmail] = useState(true);
  // Off by default: removing deletes photos, and the pairing (same original
  // name, unique on both sides, same capture time or same size) is a strong
  // hint, not proof. The admin opts in having seen the count.
  const [removeDuplicates, setRemoveDuplicates] = useState(false);

  const refresh = () => {
    // Prefix keys: the event page keys its queries by the route param.
    queryClient.invalidateQueries({ queryKey: ['event-delivery', eventId] });
    queryClient.invalidateQueries({ queryKey: ['admin-event'] });
    queryClient.invalidateQueries({ queryKey: ['admin-event-photos'] });
    queryClient.invalidateQueries({ queryKey: ['admin-events'] });
  };

  // Completing and removing duplicates are two requests with two outcomes:
  // a failed delete must not read as "could not be marked as complete" when
  // the gallery is complete and the mail is queued.
  const complete = useMutation({
    mutationFn: () => eventsService.completeDelivery(eventId, { sendEmail }),
    onSuccess: async (result) => {
      refresh();
      toast.success(result.email_queued
        ? t('events.delivery.completedMailed', 'The gallery is complete. The customer has been notified.')
        : t('events.delivery.completed', 'The gallery is complete.'));
      if (removeDuplicates && canDelete && result.duplicate_photo_ids.length > 0) {
        try {
          await photosService.deletePhotos(eventId, result.duplicate_photo_ids);
          refresh();
        } catch {
          toast.error(t('events.delivery.duplicatesNotRemoved', 'The gallery is complete, but the first-look duplicates could not be removed. Delete them from the Photos tab.'));
        }
      }
      onCompleted();
      onClose();
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      toast.error(err.response?.data?.error || t('events.delivery.completeFailed', 'The gallery could not be marked as complete.'));
    },
  });

  const panelRef = useModalFocus<HTMLDivElement>(isOpen, onClose, complete.isPending);

  if (!isOpen) return null;
  const guestsSee = Math.max(0, state.delivered_count - (removeDuplicates && canDelete ? state.duplicate_count : 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="complete-delivery-title"
      onClick={(e) => { if (e.target === e.currentTarget && !complete.isPending) onClose(); }}
    >
      <div ref={panelRef} className="bg-shell rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-4">
          <h2 id="complete-delivery-title" className="text-lg font-semibold text-heading flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-accent" />
            {t('events.delivery.completeTitle', 'Mark the full gallery as ready?')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={complete.isPending}
            className="p-1 rounded hover:bg-hover-soft"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5 text-muted" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-3 text-sm text-body">
          <p>
            {t('events.delivery.completeBody', 'The banner and the placeholder tiles disappear. The first-look badges stay. Guests then see {{count}} photos.', { count: guestsSee })}
          </p>
          <label className="flex items-start gap-3 rounded-lg border border-line p-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5 w-4 h-4" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            <span>
              <span className="font-medium text-heading block">{t('events.delivery.sendMail', 'Send the "your complete gallery is ready" email')}</span>
              <span className="text-xs text-muted">
                {t('events.delivery.sendMailHelp', 'Workflows can also react to "gallery.completed".')}
              </span>
            </span>
          </label>
          {sendEmail && (
            <GalleryRecipientsList
              inlineEmail={notice.inlineEmail}
              accountNames={notice.accountNames}
              accountCount={notice.accountCount}
              skippedAccountCount={notice.skippedAccountCount}
            />
          )}
          {state.duplicate_count > 0 && (
            <label className={`flex items-start gap-3 rounded-lg border border-line p-3 ${canDelete ? 'cursor-pointer' : 'opacity-60'}`}>
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4"
                checked={removeDuplicates && canDelete}
                disabled={!canDelete}
                onChange={(e) => setRemoveDuplicates(e.target.checked)}
              />
              <span>
                <span className="font-medium text-heading block">
                  {t('events.delivery.removeDuplicates', 'Remove {{count}} first-look duplicates', { count: state.duplicate_count })}
                </span>
                <span className="text-xs text-muted">
                  {canDelete
                    ? t('events.delivery.removeDuplicatesHelp', 'First-look photos found again in the full set: same original filename, unique on both sides, and the same capture time (or, without one, the same size). Deleting is permanent; the copies in the full set take over the badge.')
                    : t('events.delivery.removeDuplicatesNoPermission', 'Deleting photos needs the photos.delete permission.')}
                </span>
              </span>
            </label>
          )}
        </div>
        <div className="px-6 py-4 border-t border-line flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={complete.isPending}>{t('common.cancel', 'Cancel')}</Button>
          <Button variant="primary" isLoading={complete.isPending} onClick={() => complete.mutate()}>
            {sendEmail
              ? t('events.delivery.completeAndNotify', 'Mark as ready & notify')
              : t('events.delivery.completeOnly', 'Mark as ready')}
          </Button>
        </div>
      </div>
    </div>
  );
};
