import React from 'react';
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
  X
} from 'lucide-react';
import { differenceInDays, parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../hooks';

import { Button, Card, Loading } from '../../components/common';
import { UpdateNotification } from '../../components/admin/UpdateNotification';
import { WhatsNewBanner } from '../../components/admin/WhatsNewBanner';
import { CrmOverviewSection } from '../../components/admin/CrmOverviewSection';
import { useQuery } from '@tanstack/react-query';
import { eventsService } from '../../services/events.service';
import { adminService, ActivityType } from '../../services/admin.service';
import { workflowsService } from '../../services/workflows.service';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';

interface StatCard {
  title: string;
  value: string | number;
  change?: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
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
    queryFn: () => eventsService.getEvents(1, 5, 'expiring'),
  });

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
  const stats: StatCard[] = [
    {
      title: t('admin.activeEvents'),
      value: dashboardStats?.activeEvents || 0,
      icon: Calendar,
      color: 'text-green-600',
    },
    {
      title: t('admin.expiringSoon'),
      value: dashboardStats?.expiringEvents || 0,
      change: t('admin.next7Days'),
      icon: AlertTriangle,
      color: 'text-orange-600',
    },
    {
      title: t('admin.totalPhotos'),
      value: formatNumber(dashboardStats?.totalPhotos || 0),
      icon: Image,
      color: 'text-blue-600',
    },
    {
      title: t('admin.storageUsed'),
      value: adminService.formatBytes(dashboardStats?.storageUsed || 0),
      icon: HardDrive,
      color: 'text-purple-600',
    },
    {
      title: t('admin.totalViews'),
      value: formatNumber(dashboardStats?.totalViews || 0),
      change: dashboardStats?.viewsTrend ? t('admin.percentFromLastWeek', { percent: `${dashboardStats.viewsTrend > 0 ? '+' : ''}${dashboardStats.viewsTrend}` }) : undefined,
      icon: Eye,
      color: 'text-indigo-600',
    },
    {
      title: t('admin.downloads'),
      value: formatNumber(dashboardStats?.totalDownloads || 0),
      change: dashboardStats?.downloadsTrend ? t('admin.percentFromLastWeek', { percent: `${dashboardStats.downloadsTrend > 0 ? '+' : ''}${dashboardStats.downloadsTrend}` }) : undefined,
      icon: Download,
      color: 'text-pink-600',
    },
    {
      title: t('admin.archivedEvents'),
      value: dashboardStats?.archivedEvents || 0,
      icon: Archive,
      color: 'text-gray-600',
    },
    {
      title: t('admin.systemHealth'),
      value: systemHealth ? t(`admin.health.${systemHealth.overall}`) : t('admin.health.checking'),
      icon: Heart,
      color: systemHealth?.overall === 'healthy' ? 'text-green-600' : systemHealth?.overall === 'warning' ? 'text-yellow-600' : 'text-red-600',
    },
  ];

  return (
    <div>
      {/* After-update "What's New" highlights (above the update banner) */}
      <WhatsNewBanner />
      {/* Update Notification */}
      <UpdateNotification />

      {/* Page Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('navigation.dashboard')}</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('admin.dashboardSubtitle')}</p>
        </div>
        <Button
          variant="primary"
          leftIcon={<Plus className="w-5 h-5" />}
          onClick={() => navigate('/admin/events/new')}
        >
          {t('events.createEvent')}
        </Button>
      </div>

      {/* Statistics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {stats.map((stat) => (
          <Card key={stat.title} className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{stat.title}</p>
                <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 mt-1">{stat.value}</p>
                {stat.change && (
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{stat.change}</p>
                )}
              </div>
              <div className={`p-3 rounded-full bg-neutral-100 dark:bg-neutral-700 ${stat.color}`}>
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
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('admin.eventsExpiringSoon')}</h2>
              <AlertTriangle className="w-5 h-5 text-orange-600" />
            </div>

            {expiringEvents.length === 0 ? (
              <p className="text-neutral-600 dark:text-neutral-400 py-8 text-center">{t('admin.noEventsExpiring')}</p>
            ) : (
              <div className="space-y-3">
                {expiringEvents.map((event) => {
                  const daysLeft = differenceInDays(parseISO(event.expires_at!), new Date());

                  return (
                    <div
                      key={event.id}
                      className="flex items-center justify-between p-4 bg-orange-50 dark:bg-orange-900/30 rounded-lg border border-orange-200 dark:border-orange-800 cursor-pointer hover:bg-orange-100 dark:hover:bg-orange-900/50 transition-colors"
                      onClick={() => navigate(`/admin/events/${event.id}`)}
                    >
                      <div>
                        <h3 className="font-medium text-neutral-900 dark:text-neutral-100">{event.event_name}</h3>
                        {event.event_date && (
                          <p className="text-sm text-neutral-600 dark:text-neutral-400">
                            {format(parseISO(event.event_date), 'PP')}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium text-orange-600 dark:text-orange-400">
                          {t('admin.daysLeft', { count: daysLeft })}
                        </p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
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

          {/* Pending workflow approvals — the human-in-the-loop gates. Only
              rendered when the workflow engine is live and something is waiting. */}
          {!!flags.workflows && pendingApprovals && pendingApprovals.length > 0 && (
            <Card padding="md" className="mt-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('workflows.approvals.pendingTitle', 'Pending approvals')}</h2>
                <Inbox className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div className="space-y-3">
                {pendingApprovals.slice(0, 5).map((a) => {
                  const prompt = (a.payload as any)?.prompt as string | undefined;
                  const href = approvalEntityHref(a);
                  const info = (
                    <>
                      <h3 className="font-medium text-neutral-900 dark:text-neutral-100 truncate">{a.workflow_name}</h3>
                      <p className="text-sm text-neutral-600 dark:text-neutral-400 truncate">
                        {prompt || a.type}{a.entity_type ? ` · ${a.entity_type} #${a.entity_id}` : ''}
                      </p>
                    </>
                  );
                  return (
                    <div key={a.id} className="flex items-center justify-between gap-3 p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                      {href ? (
                        <button
                          type="button"
                          onClick={() => navigate(href)}
                          className="min-w-0 text-left rounded -m-1 p-1 hover:bg-purple-100/60 dark:hover:bg-purple-900/40 transition-colors cursor-pointer"
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
                  onClick={() => navigate('/admin/workflows/approvals')}
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
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('admin.recentActivity')}</h2>
            <Clock className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
          </div>

          <div className="space-y-4">
            {!recentActivity || recentActivity.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 text-center py-4">{t('admin.noRecentActivity')}</p>
            ) : (
              recentActivity.slice(0, 5).map((activity) => {
                // Get color based on activity type
                const getActivityColor = (type: ActivityType) => {
                  const colors: Partial<Record<ActivityType, string>> = {
                    'event_created': 'bg-green-500',
                    'photos_uploaded': 'bg-blue-500',
                    'event_archived': 'bg-purple-500',
                    'archive_restored': 'bg-indigo-500',
                    'archive_deleted': 'bg-red-500',
                    'bulk_download': 'bg-blue-500',
                    'email_config_updated': 'bg-yellow-500',
                    'branding_updated': 'bg-pink-500',
                    'theme_updated': 'bg-purple-500',
                    'gallery_password_entry': 'bg-gray-500',
                  };
                  return colors[type] || 'bg-gray-500';
                };

                // Format activity message with translations
                const getActivityMessage = (): string => {
                  const params: Record<string, any> = {
                    eventName: activity.eventName || t('common.unknown'),
                    // Customer/account activity keys (customer_login,
                    // customer_invitation_*, customer_updated, …) interpolate
                    // {{email}}; without it the literal placeholder rendered.
                    // Sourced the same way formatActivityMessage does.
                    email: activity.metadata?.email || activity.actorName || '',
                    count: activity.metadata?.count || 0,
                    template: activity.metadata?.template_key || '',
                    categoryName: activity.metadata?.category_name || ''
                  };
                  const translated = t(`admin.activities.${activity.type}`, params);

                  // Translate; if key missing i18n returns the key string itself
                  if (!translated || translated === `admin.activities.${activity.type}`) {
                    // Fallback: format a readable English message
                    return adminService.formatActivityMessage(activity);
                  }
                  return translated as string;
                };

                return (
                  <div key={activity.id} className="flex items-start gap-3">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${getActivityColor(activity.type)}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-neutral-900 dark:text-neutral-100 break-words">
                        {getActivityMessage()}
                      </p>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">{activity.actorName}</p>
                      <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
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
