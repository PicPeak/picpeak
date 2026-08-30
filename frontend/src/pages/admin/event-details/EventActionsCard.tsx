import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Send, Copy, Mail } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { PermissionGate } from '../../../components/admin/PermissionGate';

interface EventActionsCardProps {
  event: Event;
  onArchive: () => void;
  isArchiving: boolean;
  setShowPublishDialog: (show: boolean) => void;
  isPublishing: boolean;
  setShowDuplicateDialog: (show: boolean) => void;
  isDuplicating: boolean;
  /** Send the gallery email for an already-published gallery (#1235). */
  onSendGalleryEmail: () => void;
  isSendingGalleryEmail: boolean;
  /** Assigned customer accounts — a recipient even with no inline email. */
  assignedCustomerCount?: number;
}

export const EventActionsCard: React.FC<EventActionsCardProps> = ({
  event,
  onArchive,
  isArchiving,
  setShowPublishDialog,
  isPublishing,
  setShowDuplicateDialog,
  isDuplicating,
  onSendGalleryEmail,
  isSendingGalleryEmail,
  assignedCustomerCount = 0
}) => {
  const { t } = useTranslation();

  // Mirror the endpoint's own eligibility rules. Showing a button the backend
  // is guaranteed to reject just walks the admin through a dialog to reach a
  // generic error toast — the archived case is already handled by the caller,
  // which does not render this card at all for archived events.
  const hasRecipient = !!event.customer_email || assignedCustomerCount > 0;
  const isExpired = !!event.expires_at && new Date(event.expires_at) <= new Date();
  const isInactive = event.is_active === false;
  const canSendGalleryEmail = hasRecipient && !isExpired && !isInactive;

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.actions')}</h2>

      <div className="space-y-3">
        {event.is_draft ? (
          <PermissionGate permission="events.edit">
            <Button
              variant="primary"
              leftIcon={<Send className="w-4 h-4" />}
              onClick={() => setShowPublishDialog(true)}
              isLoading={isPublishing}
              className="w-full justify-center"
            >
              {t('events.publishAndNotify')}
            </Button>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
              {t('events.draftBanner')}
            </p>
          </PermissionGate>
        ) : (
          <>
            {/* Send the gallery email after publishing (#1235). The pair to
                publishing quietly — the address often arrives later than the
                gallery — and it doubles as a re-send when the first one was
                lost. Hidden without a recipient, since there is nowhere to
                send it.

                Its own gate, NOT nested inside the archive one below: the
                default editor role has events.edit but not events.archive, so
                nesting hid this action from exactly the people allowed to use
                the endpoint behind it. */}
            {/* Assigned accounts count as a recipient: the route falls through
                to the customer-account notice when there is no inline email,
                and the publish dialog promises that notice can be sent later —
                so hiding the button here made that promise unkeepable. */}
            {canSendGalleryEmail && (
              <PermissionGate permission="events.edit">
                <Button
                  variant="outline"
                  leftIcon={<Mail className="w-4 h-4" />}
                  onClick={onSendGalleryEmail}
                  isLoading={isSendingGalleryEmail}
                  className="w-full justify-center"
                >
                  {t('events.sendGalleryEmail.button', 'Send gallery email')}
                </Button>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center mb-3">
                  {t('events.sendGalleryEmail.help', 'Sends the gallery link to the customer. You confirm the password first if the gallery has one.')}
                </p>
              </PermissionGate>
            )}
            <PermissionGate permission="events.archive">
            <Button
              variant="outline"
              leftIcon={<Archive className="w-4 h-4" />}
              onClick={() => {
                if (confirm(t('events.archiveConfirm'))) {
                  onArchive();
                }
              }}
              isLoading={isArchiving}
              className="w-full justify-center"
            >
              {t('events.archiveEvent')}
            </Button>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
              {t('events.archivingInfo')}
            </p>
            </PermissionGate>
          </>
        )}
        {/* Duplicate (#626) — visible in both draft and live mode.
            Creates a new draft inheriting this gallery's config. */}
        <PermissionGate permission="events.create">
          <Button
            variant="outline"
            leftIcon={<Copy className="w-4 h-4" />}
            onClick={() => setShowDuplicateDialog(true)}
            isLoading={isDuplicating}
            className="w-full justify-center"
          >
            {t('events.duplicateEvent', 'Duplicate gallery')}
          </Button>
        </PermissionGate>
      </div>
    </Card>
  );
};
