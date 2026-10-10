import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Calendar, 
  AlertTriangle,
  Download,
  Eye,
  Clock,
  Plus,
  HardDrive,
  Image,
  Archive,
  Heart,
  Inbox,
  Check,
  X,
  Sparkles,
  LayoutDashboard
} from 'lucide-react';
import { parseISO } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { useExpiryRefresh } from '../../hooks/useExpiryRefresh';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/config';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../hooks';

import { Button, Card, Loading } from '../../components/common';
import { UpdateNotification } from '../../components/admin/UpdateNotification';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';
import { WhatsNewBanner } from '../../components/admin/WhatsNewBanner';
import { CrmOverviewSection } from '../../components/admin/CrmOverviewSection';
import { useQuery } from '@tanstack/react-query';
import { eventsService } from '../../services/events.service';
import { deliveryDue } from './event-details/deliveryStatus';
import { adminService, ActivityType, type Activity } from '../../services/admin.service';
import { mediaSplitLabel, splitMediaCount } from '../../utils/mediaCounts';
import { workflowsService } from '../../services/workflows.service';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';

interface StatCard {
  title: string;
  value: string | number;
  change?: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}

/**
 * Interpolation values for an `admin.activities.*` line.
 *
 * The activity's own metadata is spread in first: the keys interpolate
 * whatever the backend recorded for that type ({{name}} for
 * webhook_created, {{quoteNumber}} for quote_created, {{contractNumber}},
 * {{username}}, {{word}}, …). Before that, only a fixed five-value
 * allowlist was passed, so every other key rendered its raw "{{…}}"
 * placeholder in the activity feed (QA S7). The explicit entries below
 * stay as derived/defaulted overrides — they resolve from columns that
 * are not in metadata, or need a fallback when metadata is empty.
 */
export function buildActivityParams(activity: Activity): Record<string, unknown> {
  const t = i18n.t;
  return {
    ...activity.metadata,
    // Team and review lines (issue 743) also record the name, which outlives
    // a deleted gallery.
    eventName: activity.eventName || activity.metadata?.eventName || t('common.unknown'),
    email: activity.metadata?.email || activity.actorName || '',
    count: activity.metadata?.count || 0,
    template: activity.metadata?.template_key || '',
    categoryName: activity.metadata?.category_name || '',
    // "9 photos · 3 videos" for an upload that carried videos (issue 1430,
    // item 3); activityMessageKey picks the line that interpolates it.
    media: mediaSplitLabel(t, splitMediaCount(activity.metadata?.count, activity.metadata?.videoCount)),
  };
}

/**
 * The `admin.activities.*` key for an activity. An upload is worded by its
 * type split: the backend records videoCount next to count, and a line that
 * says "2 photos uploaded" for two clips is the wording this fixes.
 */
export function activityMessageKey(activity: Activity): string {
  if (activity.type === 'photos_uploaded' && Number(activity.metadata?.videoCount) > 0) {
    return 'admin.activities.media_uploaded';
  }
  return `admin.activities.${activity.type}`;
}

export const AdminDashboard: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { format, formatDistanceToNow } = useLocalizedDate();

  // Fetch dashboard statistics
  const { data: dashboardStats, isLoading: statsLoading } = useQuery({
    queryKey: ['admin-dashboard-stats'],
    queryFn: () => adminService.getDashboardStats(),
  });

  // Fetch recent activity
  const { data: recentActivity } = useQuery({
    queryKey: ['admin-recent-activity'],
    queryFn: () => adminService.getRecentActivity(10),
  });

  // Fetch system health. 30s cadence is fine for a freshness dashboard,
  // but we explicitly opt out of background polling so an idle browser
  // tab doesn't keep pinging the backend (24 calls/hr → 0 calls/hr
  // when the admin tabs away). React-query's default for this flag is
  // already `false`, but making it explicit documents the intent so a
  // future refactor doesn't accidentally flip it on.
  // staleTime lets a focus-regain after <30s skip the immediate
  // refetch — the interval re-fires on its own schedule.
  const { data: systemHealth } = useQuery({
    queryKey: ['admin-system-health'],
    queryFn: () => adminService.getSystemHealth(),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    staleTime: 30000,
  });

  // Fetch the next 5 expiring events directly from the server. Previously
  // this fetched the first 100 events and filtered client-side (#346 follow-up),
  // which silently missed any expiring event outside the first 100 rows.
  const { data: expiringEventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ['admin-events-summary', 'expiring'],
    // Order by soonest expiry so the five shown rows ARE the earliest to
    // expire — useExpiryRefresh then schedules against the true next boundary
    // even when >5 events are expiring (#909 review round 3).
    queryFn: () => eventsService.getEvents({ limit: 5, status: 'expiring', sortBy: 'expires_at', sortOrder: 'asc' }),
  });

  // Two-stage delivery (issue 1562): galleries whose first look is out and
  // whose full delivery is still owed, soonest promise first. The card only
  // renders when there are any.
  const { data: awaitingData } = useQuery({
    queryKey: ['admin-events-summary', 'awaiting_delivery'],
    queryFn: () => eventsService.getEvents({ limit: 20, status: 'awaiting_delivery' }),
  });
  const awaitingEvents = [...(awaitingData?.events || [])]
    .sort((a, b) => (Date.parse(a.delivery_due_at || '') || Infinity) - (Date.parse(b.delivery_due_at || '') || Infinity))
    .slice(0, 5);

  // Keep the "expiring soon" card honest when a row crosses its expiry while
  // the dashboard sits open (#909 review). Filtering client-side desynced the
  // list from the cached total/stat; instead we refetch the whole set at the
  // boundary — the backend returns rows/total/stats that already exclude the
  // now-expired event, so everything stays consistent. Fixes the stale
  // "1 day left" for roles without the health poll (editor/viewer). Placed
  // with the other top-level hooks, above the loading early-return.
  const queryClient = useQueryClient();
  const refreshExpiring = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['admin-events-summary', 'expiring'] });
    queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] });
  }, [queryClient]);
  useExpiryRefresh(
    (expiringEventsData?.events ?? []).map((e: any) => e.expires_at),
    refreshExpiring,
  );

  // Pending workflow approvals — only when the workflow engine is live. These
  // are the human-in-the-loop gates (e.g. "review invoice before sending").
  const { flags } = useFeatureFlags();
  const { data: pendingApprovals } = useQuery({
    queryKey: ['workflow-approvals'],
    queryFn: () => workflowsService.approvals(),
    enabled: !!flags.workflows,
  });
  const approvalMutation = useMutationWithToast({
    mutationFn: ({ id, action }: { id: number; action: 'confirm' | 'deny' }) => workflowsService.actApproval(id, action),
    invalidateKeys: [['workflow-approvals']],
    successMessage: t('workflows.approvals.acted', 'Done') as string,
    errorMessage: t('common.error', 'Something went wrong') as string,
  });

  // Admin detail route for an approval's run entity, so clicking opens the
  // document under review. Mirrors WorkflowApprovalsPage (`invoice` → /bills).
  const approvalEntityHref = (a: { entity_type?: string | null; entity_id?: number | null }): string | null => {
    if (!a.entity_type || a.entity_id == null) return null;
    const base: Record<string, string> = {
      quote: 'quotes', invoice: 'bills', event: 'events', contract: 'contracts', customer: 'customers',
    };
    const seg = base[a.entity_type];
    return seg ? `/admin/${seg}/${a.entity_id}` : null;
  };

  const isLoading = statsLoading || eventsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('admin.loadingDashboard')} />
      </div>
    );
  }

  const expiringEvents = expiringEventsData?.events ?? [];
  const expiringTotal = expiringEventsData?.pagination?.total ?? expiringEvents.length;

  // Format numbers for display
  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  // Build statistics cards - always show 8 cards in 2x4 grid
  const installMedia = splitMediaCount(dashboardStats?.totalPhotos, dashboardStats?.totalVideos);

  const stats: StatCard[] = [
    {
      title: t('admin.activeEvents'),
      value: dashboardStats?.activeEvents || 0,
      icon: Calendar,
      color: 'text-success-text',
    },
    {
      title: t('admin.expiringSoon'),
      value: dashboardStats?.expiringEvents || 0,
      change: t('admin.next7Days'),
      icon: AlertTriangle,
      color: 'text-warning-text',
    },
    {
      // An install that holds videos counts media and shows the split; one
      // that holds only photos keeps "Total Photos" (issue 1430).
      title: installMedia.hasVideos ? t('admin.totalMedia', 'Total Media') : t('admin.totalPhotos'),
      value: formatNumber(dashboardStats?.totalPhotos || 0),
      change: installMedia.hasVideos ? mediaSplitLabel(t, installMedia) : undefined,
      icon: Image,
      color: 'text-info-text',
    },
    {
      // Real bytes under the storage root (#1164). This used to be the summed
      // size of the catalogued originals, which on a reference-mode install is
      // the size of a NAS — the one number an admin reaches for when asking
      // "am I running out of disk" pointed away from the answer. `?? ` rather
      // than `|| `: null means the measurement failed and must read as
      // unavailable, not as 0 Bytes.
      title: t('admin.storageUsed'),
      // On an S3 backend there is no disk to measure, so the catalogued figure
      // IS the answer available and stands in — labelled by the subtitle below
      // rather than pretending a walk happened.
      value: dashboardStats?.storageUsed == null
        ? (dashboardStats?.storageMeasurement === 'catalog'
          ? adminService.formatBytes(dashboardStats.catalogedBytes)
          : t('admin.storageUnavailable', 'unavailable'))
        : `${adminService.formatBytes(dashboardStats.storageUsed)}${dashboardStats.storagePartial ? '+' : ''}`,
      // The catalogued figure alongside, so the difference is visible rather
      // than conflated. On a managed install they track each other; on a
      // reference one they are supposed to diverge.
      change: dashboardStats
        ? (dashboardStats.storageMeasurement === 'catalog'
          ? t('admin.catalogedMediaOnly', 'catalogued — objects live in S3')
          : t('admin.catalogedMedia', { size: adminService.formatBytes(dashboardStats.catalogedBytes) }))
        : undefined,
      icon: HardDrive,
      color: 'text-chart-4',
    },
    {
      title: t('admin.totalViews'),
      value: formatNumber(dashboardStats?.totalViews || 0),
      change: dashboardStats?.viewsTrend ? t('admin.percentFromLastWeek', { percent: `${dashboardStats.viewsTrend > 0 ? '+' : ''}${dashboardStats.viewsTrend}` }) : undefined,
      icon: Eye,
      color: 'text-chart-1',
    },
    {
      title: t('admin.downloads'),
      value: formatNumber(dashboardStats?.totalDownloads || 0),
      change: dashboardStats?.downloadsTrend ? t('admin.percentFromLastWeek', { percent: `${dashboardStats.downloadsTrend > 0 ? '+' : ''}${dashboardStats.downloadsTrend}` }) : undefined,
      icon: Download,
      color: 'text-chart-5',
    },
    {
      title: t('admin.archivedEvents'),
      value: dashboardStats?.archivedEvents || 0,
      icon: Archive,
      color: 'text-soft',
    },
    {
      title: t('admin.systemHealth'),
      value: systemHealth ? t(`admin.health.${systemHealth.overall}`) : t('admin.health.checking'),
      icon: Heart,
      color: systemHealth?.overall === 'healthy' ? 'text-success-text' : systemHealth?.overall === 'warning' ? 'text-warning-text' : 'text-danger-text',
    },
  ];

  return (
    <div>
      {/* After-update "What's New" highlights (above the update banner) */}
      <WhatsNewBanner />
      {/* Update Notification */}
      <UpdateNotification />

      <SectionPageHeader
        icon={LayoutDashboard}
        title={t('navigation.dashboard')}
        description={t('admin.dashboardSubtitle')}
        className="mb-8"
        actions={(
          <Button
            variant="primary"
            leftIcon={<Plus className="w-5 h-5" />}
            onClick={() => navigate('/admin/events/new')}
          >
            {t('events.createEvent')}
          </Button>
        )}
      />

      {/* Statistics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {stats.map((stat) => (
          <Card key={stat.title} className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-soft">{stat.title}</p>
                <p className="text-2xl font-bold text-heading mt-1">{stat.value}</p>
                {stat.change && (
                  <p className="text-sm text-muted mt-1">{stat.change}</p>
                )}
              </div>
              <div className={`p-3 rounded-full bg-inset ${stat.color}`}>
                <stat.icon className="w-6 h-6" />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Expiring Events */}
        <div className="lg:col-span-2">
          <Card padding="md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-heading">{t('admin.eventsExpiringSoon')}</h2>
              <AlertTriangle className="w-5 h-5 text-warning-text" />
            </div>

            {expiringEvents.length === 0 ? (
              <p className="text-soft py-8 text-center">{t('admin.noEventsExpiring')}</p>
            ) : (
              <div className="space-y-3">
                {expiringEvents.map((event) => {
                  // Ceiling so the final partial day reads "1 day", not "0"
                  // (#909); clamped since a row can sit at the boundary for the
                  // instant before useExpiryRefresh refetches it away.
                  const daysLeft = Math.max(1, Math.ceil((parseISO(event.expires_at!).getTime() - Date.now()) / 86400000));

                  return (
                    <div
                      key={event.id}
                      className="flex items-center justify-between p-4 bg-warning-soft rounded-lg border border-warning-line cursor-pointer transition-colors"
                      onClick={() => navigate(`/admin/events/${event.id}`)}
                    >
                      <div>
                        <h3 className="font-medium text-heading">{event.event_name}</h3>
                        {event.event_date && (
                          <p className="text-sm text-soft">
                            {format(parseISO(event.event_date), 'PP')}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium text-warning-text">
                          {t('admin.daysLeft', { count: daysLeft })}
                        </p>
                        <p className="text-xs text-muted">
                          {t('gallery.expires')} {format(parseISO(event.expires_at!), 'PP')}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {expiringTotal > 5 && (
              <button
                onClick={() => navigate('/admin/events?filter=expiring')}
                className="w-full mt-4 text-sm text-accent hover:opacity-80 font-medium"
              >
                {t('admin.viewAllExpiringEvents', { count: expiringTotal })} →
              </button>
            )}
          </Card>

          {awaitingEvents.length > 0 && (
            <Card padding="md" className="mt-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-heading">{t('events.delivery.awaitingFilter', 'Awaiting full gallery')}</h2>
                <Sparkles className="w-5 h-5 text-accent" />
              </div>
              <div className="space-y-3">
                {awaitingEvents.map((event) => {
                  const due = deliveryDue(event.delivery_due_at);
                  const tone = due?.tone === 'overdue'
                    ? 'text-danger-text'
                    : due?.tone === 'soon' ? 'text-warning-text' : 'text-body';
                  return (
                    <div
                      key={event.id}
                      className="flex items-center justify-between p-4 bg-inset rounded-lg border border-line cursor-pointer hover:bg-hover transition-colors"
                      onClick={() => navigate(`/admin/events/${event.id}`)}
                    >
                      <div>
                        <h3 className="font-medium text-heading">{event.event_name}</h3>
                        <p className="text-sm text-soft">
                          {event.delivery_expected_count
                            ? t('events.delivery.progressShort', '{{count}} of ~{{expected}} photos', { count: event.photo_count || 0, expected: event.delivery_expected_count })
                            : t('events.delivery.progressNoExpected', '{{count}} photos so far', { count: event.photo_count || 0 })}
                        </p>
                      </div>
                      {due && (
                        <p className={`text-sm font-medium text-right ${tone}`}>
                          {due.tone === 'overdue'
                            ? t('events.delivery.overdueShort', 'Overdue since {{date}}', { date: format(due.date) })
                            : t('events.delivery.dueShort', 'Due {{date}}', { date: format(due.date) })}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {(awaitingData?.events?.length || 0) > 5 && (
                <button
                  onClick={() => navigate('/admin/events?filter=awaiting_delivery')}
                  className="w-full mt-4 text-sm text-accent hover:opacity-80 font-medium"
                >
                  {t('events.delivery.viewAllAwaiting', 'Show all')} →
                </button>
              )}
            </Card>
          )}

          {/* Pending workflow approvals — the human-in-the-loop gates. Only
              rendered when the workflow engine is live and something is waiting. */}
          {!!flags.workflows && pendingApprovals && pendingApprovals.length > 0 && (
            <Card padding="md" className="mt-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-heading">{t('workflows.approvals.pendingTitle', 'Pending approvals')}</h2>
                <Inbox className="w-5 h-5 text-warning-text" />
              </div>
              <div className="space-y-3">
                {pendingApprovals.slice(0, 5).map((a) => {
                  const prompt = (a.payload as any)?.prompt as string | undefined;
                  const href = approvalEntityHref(a);
                  const info = (
                    <>
                      <h3 className="font-medium text-heading truncate">{a.workflow_name}</h3>
                      <p className="text-sm text-soft truncate">
                        {prompt || a.type}{a.entity_type ? ` · ${a.entity_type} #${a.entity_id}` : ''}
                      </p>
                    </>
                  );
                  return (
                    <div key={a.id} className="flex items-center justify-between gap-3 p-4 bg-warning-soft rounded-lg border border-warning-line">
                      {href ? (
                        <button
                          type="button"
                          onClick={() => navigate(href)}
                          className="min-w-0 text-left rounded -m-1 p-1 hover:bg-warning-line transition-colors cursor-pointer"
                          title={t('workflows.approvals.openEntity', 'Open {{type}} #{{id}}', { type: a.entity_type, id: a.entity_id }) as string}
                        >
                          {info}
                        </button>
                      ) : (
                        <div className="min-w-0">{info}</div>
                      )}
                      <div className="flex items-center gap-2 shrink-0">
                        <Button variant="primary" size="sm" isLoading={approvalMutation.isPending}
                          onClick={() => approvalMutation.mutate({ id: a.id, action: 'confirm' })}
                          leftIcon={<Check className="w-4 h-4" />}>
                          {t('workflows.approvals.confirm', 'Confirm')}
                        </Button>
                        <Button variant="outline" size="sm" isLoading={approvalMutation.isPending}
                          onClick={() => approvalMutation.mutate({ id: a.id, action: 'deny' })}
                          leftIcon={<X className="w-4 h-4" />}>
                          {t('workflows.approvals.deny', 'Deny')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {pendingApprovals.length > 5 && (
                <button
                  onClick={() => navigate('/admin/automation/approvals')}
                  className="w-full mt-4 text-sm text-accent hover:opacity-80 font-medium"
                >
                  {t('workflows.approvals.viewAll', 'View all approvals')} →
                </button>
              )}
            </Card>
          )}
        </div>

        {/* Recent Activity */}
        <Card padding="md">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-heading">{t('admin.recentActivity')}</h2>
            <Clock className="w-5 h-5 text-muted" />
          </div>

          <div className="space-y-4">
            {!recentActivity || recentActivity.length === 0 ? (
              <p className="text-sm text-muted text-center py-4">{t('admin.noRecentActivity')}</p>
            ) : (
              recentActivity.slice(0, 5).map((activity) => {
                // Get color based on activity type
                const getActivityColor = (type: ActivityType) => {
                  const colors: Partial<Record<ActivityType, string>> = {
                    'event_created': 'bg-success',
                    'photos_uploaded': 'bg-info',
                    'event_archived': 'bg-chart-4',
                    'archive_restored': 'bg-chart-1',
                    'archive_deleted': 'bg-danger',
                    'bulk_download': 'bg-info',
                    'email_config_updated': 'bg-chart-3',
                    'branding_updated': 'bg-chart-5',
                    'theme_updated': 'bg-chart-4',
                    'gallery_password_entry': 'bg-faint',
                  };
                  return colors[type] || 'bg-faint';
                };

                // Format activity message with translations
                const getActivityMessage = (): string => {
                  const params = buildActivityParams(activity);
                  const key = activityMessageKey(activity);
                  const translated = t(key, params);

                  // Translate; if key missing i18n returns the key string itself
                  if (!translated || translated === key) {
                    // Fallback: format a readable English message
                    return adminService.formatActivityMessage(activity);
                  }
                  return translated as string;
                };

                return (
                  <div key={activity.id} className="flex items-start gap-3">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${getActivityColor(activity.type)}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-heading break-words">
                        {getActivityMessage()}
                      </p>
                      <p className="text-xs text-muted">{activity.actorName}</p>
                      <p className="text-xs text-faint mt-1">
                        {formatDistanceToNow(parseISO(activity.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

        </Card>
      </div>

      {/* CRM overview — quote / invoice pipeline + revenue +
          outstanding. The section internally gates on the `clients`
          feature flag (renders nothing when off), and further hides
          the quotes / invoices subsections individually when their
          sub-flag is off. Lives at the bottom so admins who don't
          use the CRM see no visual difference. */}
      <CrmOverviewSection />

    </div>
  );
};

AdminDashboard.displayName = 'AdminDashboard';
