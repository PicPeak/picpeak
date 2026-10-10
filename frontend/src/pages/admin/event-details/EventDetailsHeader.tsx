import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ExternalLink,
  Info,
  Calendar,
  Archive,
  Copy,
  Mail,
  Pencil,
  Receipt,
  Send,
  Sparkles,
  CheckCircle2
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { eventsService } from '../../../services/events.service';
import { CompleteDeliveryDialog } from './CompleteDeliveryDialog';
import { deliveryDue, isAwaitingFullGallery } from './deliveryStatus';
import type { Event } from '../../../types';
import { ActionMenu, Badge, Button, Notice, type ActionMenuItem } from '../../../components/common';
import { useConfirm } from '../../../components/common/ConfirmDialog';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../../contexts/PermissionsContext';
import { buildShareLinkUrl } from '../../../utils/url';
import { isGalleryPublic } from '../../../utils/accessControl';
import { safeParseDate } from './utils';
import { canSendGalleryEmail, useAccountReach } from './OverviewTab';

interface EventDetailsHeaderProps {
  event: Event;
  setShowRenameDialog: (show: boolean) => void;
  setShowPublishDialog: (show: boolean) => void;
  setShowDuplicateDialog: (show: boolean) => void;
  onSendGalleryEmail: () => void;
  isSendingGalleryEmail: boolean;
  onArchive: () => void;
  isPublishing: boolean;
  onExtendExpiration: (days: number) => void;
  daysUntilExpiration: number | null;
  isExpired: boolean;
  isExpiring: boolean;
}

/**
 * The draft marker. What a draft means is its tooltip; the info icon says
 * there is one. It opens on hover, keyboard focus, and on click or tap via
 * its own state, since Safari does not focus a button it clicks. Escape or a
 * click elsewhere closes it; Escape also hides it while it is still hovered
 * or focused (WCAG 1.4.13), until the pointer or focus leaves.
 */
export const DraftPill: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <button
      ref={ref}
      type="button"
      data-tooltip={t('events.draftBanner')}
      aria-label={`${t('events.draft')}: ${t('events.draftBanner')}`}
      onClick={() => { setDismissed(false); setOpen((o) => !o); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setDismissed(true); } }}
      onBlur={() => setDismissed(false)}
      onMouseLeave={() => setDismissed(false)}
      className={`info-tooltip info-tooltip-start ${open ? 'is-open' : ''} ${dismissed ? 'is-dismissed' : ''} items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning-soft text-warning-text hover:brightness-95`}
    >
      {t('events.draft')}
      <Info className="w-3.5 h-3.5" aria-hidden="true" />
    </button>
  );
};

export const EventDetailsHeader: React.FC<EventDetailsHeaderProps> = ({
  event,
  setShowRenameDialog,
  setShowPublishDialog,
  setShowDuplicateDialog,
  onSendGalleryEmail,
  isSendingGalleryEmail,
  onArchive,
  isPublishing,
  onExtendExpiration,
  daysUntilExpiration,
  isExpired,
  isExpiring
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { flags } = useFeatureFlags();
  const reach = useAccountReach();
  const { hasPermission, hasAnyPermission } = usePermissions();
  const confirm = useConfirm();
  const archived = Boolean(event.is_archived);
  const canHelpClient = hasAnyPermission(['events.edit', 'events.support']) && !event.share_secrets_hidden;

  // Two-stage delivery (issue 1562): the pill says how close the promised
  // date is; the button is the one place the full gallery is announced.
  const awaiting = isAwaitingFullGallery(event) && !archived;
  const [completeOpen, setCompleteOpen] = useState(false);
  const { data: delivery, refetch: refetchDelivery } = useQuery({
    queryKey: ['event-delivery', event.id],
    queryFn: () => eventsService.getDelivery(event.id),
    enabled: awaiting,
  });
  const due = deliveryDue(event.delivery_due_at);

  const canEdit = !archived && hasPermission('events.edit');
  const menuItems: ActionMenuItem[] = [];
  if (hasPermission('events.create')) {
    menuItems.push({ key: 'duplicate', label: t('events.duplicateEvent', 'Duplicate gallery'), icon: <Copy className="w-4 h-4" />, onSelect: () => setShowDuplicateDialog(true) });
  }
  if (flags.bills && hasPermission('bills.manage')) {
    menuItems.push({
      key: 'invoice',
      label: t('events.createInvoice', 'Create invoice'),
      icon: <Receipt className="w-4 h-4" />,
      onSelect: () => {
        // Pre-fills the bill editor with the event and, when exactly one is
        // linked, its customer.
        const accts = ((event as { customer_accounts?: Array<{ id: number }> }).customer_accounts) || [];
        const params = new URLSearchParams({ eventId: String(event.id) });
        if (event.event_name) params.set('eventName', event.event_name);
        if (event.event_date) params.set('eventDate', String(event.event_date).slice(0, 10));
        if (accts.length === 1) params.set('customerAccountId', String(accts[0].id));
        navigate(`/admin/clients/bills/new?${params.toString()}`);
      },
    });
  }
  // Archiving is the owner's (issue 743); an older payload without the
  // field is read as the owner's.
  if (!archived && !event.is_draft && hasPermission('events.archive') && event.can_manage_assignments !== false) {
    menuItems.push({
      key: 'archive',
      label: t('events.archiveEvent'),
      icon: <Archive className="w-4 h-4" />,
      danger: true,
      onSelect: async () => {
        if (await confirm({ message: t('events.archiveConfirm'), variant: 'danger' })) onArchive();
      },
    });
  }

  return (
    <>
      <div className="mb-6">
        {/* No back arrow: the gallery list is the Events entry in the sidebar,
            which is on screen here (detail pages navigate by the sidebar; #1730). */}

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 w-full sm:w-auto">
            {/* Renaming sits on the name it changes. It stays a dialog, not
                inline editing: a rename can move the gallery's URL and resend
                the customer email, which the dialog explains and asks about. */}
            <div className="flex items-start gap-2">
              <h1 className="min-w-0 text-2xl font-bold text-heading break-words">{event.event_name}</h1>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setShowRenameDialog(true)}
                  className="mt-1 p-1 rounded-lg text-soft hover:text-heading hover:bg-hover shrink-0"
                  aria-label={t('events.rename.button', 'Rename')}
                  title={t('events.rename.button', 'Rename')}
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
              {/* On a phone the menu sits on the title row, pinned right, so
                  View gallery and the primary action fit next to each other
                  below. From sm it is the first item of the action row. */}
              <ActionMenu items={menuItems} align="right" size="icon-sm" label={t('events.header.moreActions', 'More actions')} className="ml-auto shrink-0 sm:hidden" />
            </div>
            <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-soft">
              {event.event_date && (
                <span className="flex items-center">
                  <Calendar className="w-4 h-4 mr-1" />
                  {format(safeParseDate(event.event_date)!, 'PPP')}
                </span>
              )}
              <span className="capitalize">{event.event_type}</span>
              <Badge tone={isGalleryPublic(event.require_password) ? 'success' : 'neutral'}>
                {isGalleryPublic(event.require_password) ? t('events.publicAccess', 'Public access') : t('events.passwordProtected', 'Password protected')}
              </Badge>
              {/* The pill is the only draft marker: what a draft means is its
                  tooltip, and Publish is in the action row. The row is
                  `relative`: on a phone the tooltip anchors to it, so it
                  starts at the content edge wherever the pill wrapped to. */}
              {event.is_draft ? <DraftPill /> : null}
              {archived ? (
                <span className="text-muted flex items-center">
                  <Archive className="w-4 h-4 mr-1" />
                  {t('events.archived')}
                </span>
              ) : null}
              {awaiting && (
                <Badge
                  tone={due?.tone === 'overdue' ? 'danger' : due?.tone === 'soon' ? 'warning' : 'neutral'}
                  icon={<Sparkles />}
                >
                  {!due
                    ? t('events.delivery.pill', 'First look')
                    : due.tone === 'overdue'
                      ? t('events.delivery.pillOverdue', 'First look · overdue')
                      : t('events.delivery.pillDue', 'First look · due in {{count}} d', { count: due.days })}
                </Badge>
              )}
            </div>
          </div>

          {/* Secondary first: the menu, then View gallery, then the one
              primary action of the moment (publish a draft, send the gallery
              email, announce the full gallery) at the end of the row. */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* Anchored right too: the row sits at the right edge, so with only
                the menu (or one button) in it a left-anchored dropdown would
                run past the content column. */}
            <ActionMenu items={menuItems} align="right" size="icon-sm" label={t('events.header.moreActions', 'More actions')} className="hidden sm:block" />
            {event.share_link && (
              <a
                // Admin preview (#868): an explicit intent flag, no token in the
                // URL; the httpOnly admin cookie authenticates the API calls.
                href={`${buildShareLinkUrl(event.share_link)}${buildShareLinkUrl(event.share_link).includes('?') ? '&' : '?'}admin_preview=1`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent hover:opacity-80 border border-accent-dark rounded-lg hover:bg-accent-dark/15 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                {t('events.viewGallery')}
              </a>
            )}
            {/* !! — SQLite returns integer booleans; a bare 0 would render as "0" */}
            {!!event.is_draft && canEdit && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Send className="w-4 h-4" />}
                onClick={() => setShowPublishDialog(true)}
                isLoading={isPublishing}
              >
                {/* Just "Publish": the dialog asks whether to notify. */}
                {t('events.publish', 'Publish')}
              </Button>
            )}
            {canHelpClient && canSendGalleryEmail(event, reach) && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Mail className="w-4 h-4" />}
                onClick={onSendGalleryEmail}
                isLoading={isSendingGalleryEmail}
              >
                {t('events.sendGalleryEmail.button', 'Send gallery email')}
              </Button>
            )}
            {awaiting && hasPermission('events.edit') && delivery && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<CheckCircle2 className="w-4 h-4" />}
                onClick={() => setCompleteOpen(true)}
              >
                {t('events.delivery.completeButton', 'Full gallery is ready')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {delivery && (
        <CompleteDeliveryDialog
          event={event}
          state={delivery}
          isOpen={completeOpen}
          onClose={() => setCompleteOpen(false)}
          onCompleted={() => { refetchDelivery(); }}
        />
      )}

      {/* Expiration Warning */}
      {!archived && (isExpired || isExpiring) && (
        <Notice
          tone={isExpired ? 'danger' : 'warning'}
          className="mb-6"
          title={isExpired
            ? t('events.eventExpiredMessage')
            : t('events.eventExpiresIn', { days: daysUntilExpiration })}
          action={!isExpired && canHelpClient ? (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (await confirm({ message: `${t('events.extendExpiration', { days: 7 })}?` })) onExtendExpiration(7);
              }}
            >
              {t('events.extendSevenDays')}
            </Button>
          ) : undefined}
        >
          {isExpired ? t('events.guestsCannotAccessGallery') : t('events.warningEmailsHaveBeenSent')}
        </Notice>
      )}
    </>
  );
};
