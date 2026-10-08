/**
 * Overview: what the gallery is and how to reach it, plus the one-click
 * actions for helping a client. Nothing here is a setting — those live in the
 * Settings tab — so the tab needs no edit mode.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CalendarClock, Eye, Mail } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { FeedbackModerationPanel } from '../../../components/admin';
import { ShortUrlsCard } from '../../../components/admin/ShortUrlsCard';
import { useAnyPermission, usePermission } from '../../../hooks/usePermission';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useFeatureEnabled, useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { toBoolean } from '../../../utils/parsers';
import { accountName, galleryRecipients, type RecipientAccount } from '../../../utils/galleryRecipients';
import type { FeedbackSettings as FeedbackSettingsType } from '../../../services/feedback.service';
import type { EventDetailsTab } from './types';
import type { SettingsSectionKey } from './settings/draft';
import { usesCustomTheme } from './settings/draft';
import { ShareLinkCard } from './ShareLinkCard';
import { ClientAccessCard } from './ClientAccessCard';
import { PhotoStatisticsCard } from './PhotoStatisticsCard';
import { ArchiveStatusCard } from './ArchiveStatusCard';
import { DownloadLimitUsage } from './DownloadLimitUsage';
import { safeParseDate } from './utils';

interface OverviewTabProps {
  event: Event;
  id: string | undefined;
  passwordVersion?: number;
  feedbackSettings: FeedbackSettingsType | undefined;
  categories: Array<{ id: number; name: string; slug: string; is_folder?: boolean }>;
  daysUntilExpiration: number | null;
  refetchEvent: () => void;
  setActiveTab: (tab: EventDetailsTab) => void;
  openSettings: (section: SettingsSectionKey) => void;
  setShowPasswordReset: (show: boolean) => void;
  onSendGalleryEmail: () => void;
  isSendingGalleryEmail: boolean;
  onExtendExpiration: (days: number) => void;
  isExtending: boolean;
  onRevealNow: () => void;
}

/** The customer accounts assigned to the gallery, as the event detail route returns them. */
export function assignedAccounts(event: Event): RecipientAccount[] {
  return (event as { customer_accounts?: RecipientAccount[] }).customer_accounts || [];
}

/** Whether this admin's gallery notices reach customer accounts at all. */
export interface AccountReach {
  portalEnabled: boolean;
  /** customers.events, as the backend requires on every announcing route. */
  canAnnounceToAccounts: boolean;
}

export function useAccountReach(): AccountReach {
  return {
    portalEnabled: useFeatureEnabled('customerPortal'),
    canAnnounceToAccounts: usePermission('customers.events'),
  };
}

/** Who a gallery notice for this event reaches, as the dialogs show it. */
export interface EventNotice {
  /** Gets the standard gallery email. */
  inlineEmail: string | null;
  /** Account names — only when the admin may view customers. */
  accountNames: string[];
  /** Accounts that get the portal email (names or not). */
  accountCount: number;
  /** Accounts the notice would reach that this admin may not mail (customers.events). */
  skippedAccountCount: number;
}

interface GalleryNoticeCounts { account_count: number; folds_inline: boolean }

/**
 * Whether assigned accounts are told about this gallery at all: not a draft,
 * not archived, not expired. Mirrors galleryNotificationService.accountsAnnounceable.
 */
export function accountsAnnounceable(event: Event, now: Date = new Date()): boolean {
  if (toBoolean(event.is_draft, false) || toBoolean(event.is_archived, false)) return false;
  if (!event.expires_at) return true;
  const expires = new Date(event.expires_at);
  return Number.isNaN(expires.getTime()) || expires > now;
}

export interface EventNoticeOptions {
  /**
   * One person in both fields always gets the portal version, whatever the
   * gallery email would carry (the "complete gallery" mail: preferPortal on
   * the server).
   */
  preferPortal?: boolean;
  /** False when the mail reaches no account (accountsAnnounceable). */
  accountsAnnounced?: boolean;
}

/**
 * Mirrors galleryNotificationService. With the account list (customers.view)
 * it is computed here and names the accounts; without it, from the server's
 * permission-safe `gallery_notice` counts.
 */
export function eventNotice(event: Event, reach: AccountReach, { preferPortal = false, accountsAnnounced = true }: EventNoticeOptions = {}): EventNotice {
  const contact = event.customer_email?.trim() || null;
  // No account is mailed: the customer email gets the mail, unfolded.
  if (!accountsAnnounced) return { inlineEmail: contact, accountNames: [], accountCount: 0, skippedAccountCount: 0 };
  const listed = assignedAccounts(event);
  const server = (event as { gallery_notice?: GalleryNoticeCounts | null }).gallery_notice;
  const options = {
    portalEnabled: reach.portalEnabled,
    prefersGalleryEmail: !preferPortal && (!!event.welcome_message?.trim() || toBoolean(event.client_access_enabled, false)),
  };
  if (listed.length > 0 || !server) {
    const local = galleryRecipients(contact, listed, { ...options, includeAccounts: reach.canAnnounceToAccounts });
    const reachable = galleryRecipients(contact, listed, { ...options, includeAccounts: true }).accounts.length;
    return {
      inlineEmail: local.inlineEmail,
      accountNames: local.accounts.map(accountName),
      accountCount: local.accounts.length,
      skippedAccountCount: reach.canAnnounceToAccounts ? 0 : reachable,
    };
  }
  if (!reach.canAnnounceToAccounts) {
    return { inlineEmail: contact, accountNames: [], accountCount: 0, skippedAccountCount: server.account_count };
  }
  return {
    inlineEmail: server.folds_inline ? null : contact,
    accountNames: [],
    accountCount: server.account_count,
    skippedAccountCount: 0,
  };
}

export function canSendGalleryEmail(event: Event, reach: AccountReach): boolean {
  const { inlineEmail, accountCount } = eventNotice(event, reach);
  const hasRecipient = !!inlineEmail || accountCount > 0;
  const isExpired = !!event.expires_at && new Date(event.expires_at) <= new Date();
  return hasRecipient && !isExpired && toBoolean(event.is_active, true) && !event.is_draft && !event.is_archived;
}

const SummaryRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start justify-between gap-4 py-2.5 border-t border-line first:border-t-0">
    <span className="text-sm text-soft">{label}</span>
    <span className="text-sm text-heading text-right">{children}</span>
  </div>
);

export const OverviewTab: React.FC<OverviewTabProps> = ({
  event,
  id,
  passwordVersion,
  feedbackSettings,
  categories,
  daysUntilExpiration,
  refetchEvent,
  setActiveTab,
  openSettings,
  setShowPasswordReset,
  onSendGalleryEmail,
  isSendingGalleryEmail,
  onExtendExpiration,
  isExtending,
  onRevealNow,
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { flags } = useFeatureFlags();
  const reach = useAccountReach();
  const portalEnabled = reach.portalEnabled;
  const accounts = assignedAccounts(event);
  const canHelpClient = useAnyPermission(['events.edit', 'events.support']) && !event.share_secrets_hidden;
  // Revealing changes what guests see; the route needs events.edit.
  const canReveal = usePermission('events.edit') && !event.share_secrets_hidden;
  const archived = Boolean(event.is_archived);
  const expiresAt = safeParseDate(event.expires_at);
  const hiddenUntilReveal = toBoolean(event.reveal_mode, false) && !event.revealed_at;
  // The Details card's customer accounts link each name to its customer page
  // when that page is reachable: the route sits behind the `clients` flag
  // plus `customerPortal` or `newsletters`, and needs customers.view. The row
  // itself only shows with the portal on (portalEnabled below), so a link
  // never points at a page the install has switched off.
  const canOpenCustomers = usePermission('customers.view')
    && !!flags.clients && (!!flags.customerPortal || !!flags.newsletters);

  const link = (section: SettingsSectionKey, text: string) => (
    <button type="button" className="text-accent hover:underline" onClick={() => openSettings(section)}>{text}</button>
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6">
      <div className="space-y-6 min-w-0">
        <ShareLinkCard event={event} setShowPasswordReset={setShowPasswordReset} passwordVersion={passwordVersion} />
        <ShortUrlsCard eventId={event.id} />

        {!archived && canHelpClient && (
          <Card padding="md">
            <h2 className="text-lg font-semibold text-heading">{t('events.overviewTab.helpClient', 'Help the client')}</h2>
            <p className="text-sm text-soft mt-1 mb-4">
              {t('events.overviewTab.helpClientHint', 'Actions that take effect at once. Password and resend-email are on the share card above.')}
            </p>
            <div className="flex flex-wrap gap-2">
              {canSendGalleryEmail(event, reach) && (
                <Button variant="outline" size="sm" leftIcon={<Mail className="w-4 h-4" />} onClick={onSendGalleryEmail} isLoading={isSendingGalleryEmail}>
                  {t('events.sendGalleryEmail.button', 'Send gallery email')}
                </Button>
              )}
              {expiresAt && (
                <>
                  <Button variant="outline" size="sm" leftIcon={<CalendarClock className="w-4 h-4" />} onClick={() => onExtendExpiration(30)} isLoading={isExtending}>
                    {t('events.overviewTab.extendDays', '+{{days}} days', { days: 30 })}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onExtendExpiration(90)} disabled={isExtending}>
                    {t('events.overviewTab.extendDays', '+{{days}} days', { days: 90 })}
                  </Button>
                </>
              )}
              {hiddenUntilReveal && canReveal && (
                <Button variant="outline" size="sm" leftIcon={<Eye className="w-4 h-4" />} onClick={onRevealNow}>
                  {t('events.revealNow', 'Reveal now')}
                </Button>
              )}
            </div>
          </Card>
        )}

        <ClientAccessCard event={event} refetchEvent={refetchEvent} />

        {!archived && feedbackSettings?.feedback_enabled && (
          <div className="space-y-2">
            <FeedbackModerationPanel eventId={parseInt(id!)} compact={true} maxItems={3} />
            <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => setActiveTab('guests')}>
              {t('events.overviewTab.openFeedback', 'Open Guests & Feedback')}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-6">
        <PhotoStatisticsCard event={event} categories={categories} setActiveTab={setActiveTab} />

        <Card padding="md">
          <h2 className="text-lg font-semibold text-heading mb-2">{t('events.overviewTab.details', 'Details')}</h2>
          <SummaryRow label={t('events.hostName')}>{event.customer_name || <span className="text-muted">{t('common.notSet')}</span>}</SummaryRow>
          <SummaryRow label={t('events.hostEmail')}>{event.customer_email || <span className="text-muted">{t('common.notSet')}</span>}</SummaryRow>
          {portalEnabled && accounts.length > 0 && (
            <SummaryRow label={t('events.customerPicker.label', 'Customer accounts')}>
              <span className="flex flex-col items-end gap-0.5">
                {(accounts as Array<RecipientAccount & { id: number }>).map((c) => (
                  canOpenCustomers ? (
                    <Link key={c.id} to={`/admin/clients/accounts/${c.id}`} className="text-accent hover:underline" title={c.email || undefined}>
                      {accountName(c) || `#${c.id}`}
                    </Link>
                  ) : (
                    <span key={c.id}>{accountName(c) || `#${c.id}`}</span>
                  )
                ))}
              </span>
            </SummaryRow>
          )}
          {/* Team members (issue 743); changed in Settings → General. */}
          {(event.assigned_admins?.length ?? 0) > 0 && (
            <SummaryRow label={t('events.team.label', 'Team members')}>
              <span className="flex flex-col items-end gap-0.5">
                {(event.assigned_admins ?? []).map((a) => (
                  <span key={a.id} title={a.role_name || undefined}>{a.username}</span>
                ))}
              </span>
            </SummaryRow>
          )}
          {event.admin_email && <SummaryRow label={t('events.adminEmail')}>{event.admin_email}</SummaryRow>}
          {event.created_at && <SummaryRow label={t('events.created')}>{format(safeParseDate(event.created_at)!, 'PP')}</SummaryRow>}
          <SummaryRow label={t('events.expires')}>
            {expiresAt ? (
              <>
                {format(expiresAt, 'PP')}
                {!archived && daysUntilExpiration !== null && daysUntilExpiration > 0 && (
                  <span className="text-muted ml-1">{t('events.daysLeft', { count: daysUntilExpiration })}</span>
                )}
              </>
            ) : t('events.neverExpires', 'Never')}
          </SummaryRow>
          {!!event.allow_downloads && !!event.download_limit && (
            <div className="py-2.5 border-t border-line">
              {/* Usage for everyone; its Reset is gated inside. */}
              <DownloadLimitUsage eventId={event.id} downloadLimit={event.download_limit} ownedByOther={!!event.share_secrets_hidden} />
            </div>
          )}
          {hiddenUntilReveal && (
            <SummaryRow label={t('events.revealModeStatus', 'Reveal mode')}>
              {event.reveal_at
                ? t('events.revealScheduled', 'Scheduled: {{date}}', { date: format(new Date(event.reveal_at), 'PPp') })
                : t('events.hiddenUntilReveal', 'Hidden from guests')}
            </SummaryRow>
          )}
        </Card>

        <Card padding="md">
          <h2 className="text-lg font-semibold text-heading mb-2">{t('events.overviewTab.setup', 'Setup')}</h2>
          <SummaryRow label={t('events.settingsTab.source', 'Photo source')}>
            {link('source', event.source_mode === 'reference'
              ? (toBoolean(event.external_watch, false)
                ? t('events.overviewTab.sourceWatched', 'External folder · watched')
                : t('events.overviewTab.sourceExternal', 'External folder'))
              : t('events.overviewTab.sourceUploads', 'Uploads'))}
          </SummaryRow>
          <SummaryRow label={t('events.settingsTab.appearance', 'Appearance')}>
            {link('appearance', usesCustomTheme(event)
              ? t('events.overviewTab.themeCustom', 'Custom styling')
              : t('events.settingsTab.globalTheme', 'Global theme (Branding)'))}
          </SummaryRow>
          <SummaryRow label={t('events.settingsTab.downloads', 'Downloads')}>
            {link('downloads', event.allow_downloads === false || (event.allow_downloads as unknown) === 0
              ? t('events.downloadsDisabled', 'Downloads Disabled')
              : t('events.overviewTab.downloadsOn', 'Allowed'))}
          </SummaryRow>
          {flags.reminderEmails && (
            <SummaryRow label={t('eventReminderOverride.title', 'Pre-event reminder')}>
              {link('reminder', toBoolean(event.event_reminder_disabled, false)
                ? t('events.overviewTab.reminderOff', 'Off for this gallery')
                : event.event_reminder_sent_at
                  ? t('events.overviewTab.reminderSent', 'Sent {{date}}', { date: format(new Date(event.event_reminder_sent_at), 'PP') })
                  : t('events.overviewTab.reminderOn', 'On'))}
            </SummaryRow>
          )}
        </Card>

        {archived ? <ArchiveStatusCard event={event} id={id} /> : null}
      </div>
    </div>
  );
};
