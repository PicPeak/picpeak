/**
 * Admin → Project Cockpit (the 360° Project Overview).
 *
 * One project, everything in it: an editable header, a milestone timeline,
 * and a single dated feed merging every email (with the actual sent HTML
 * preview + resend/cancel/retry/send-now actions), quote, contract, invoice,
 * gallery and logged hour that rolls up to the project. Admin-only.
 */
import React, { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  Mail, FileText, ScrollText, Receipt, Image as ImageIcon, Clock,
  X, Send, RotateCw, Ban, Eye, Save, ArrowLeft, Plus, Search,
} from 'lucide-react';
import { Button, Card, Input, Loading } from '../../../components/common';
import {
  projectsService,
  type ProjectOverview,
  type EmailPreview,
  type ProjectMilestone,
} from '../../../services/projects.service';
import { eventsService } from '../../../services/events.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../../utils/money';
import { useFeatureFlags, type FeatureKey } from '../../../contexts/FeatureFlagsContext';

type FeedKind = 'email' | 'quote' | 'contract' | 'invoice' | 'gallery' | 'hours';

interface FeedItem {
  key: string;
  kind: FeedKind;
  date: string | null;
  title: string;
  subtitle?: string;
  amount?: string;
  status?: string;
  href?: string | null;
  emailId?: number;
  emailStatus?: string;
  reRendered?: boolean;
}

/** The feature flag that gates each document's detail ROUTE (RequireFeature
 *  in App.tsx). The cockpit surfaces docs by permission, but their detail
 *  pages live behind these flags — so a link is only live when the flag is
 *  on, else clicking would bounce to /admin/dashboard. Galleries/events have
 *  no such gate. */
const FLAG_FOR_KIND: Partial<Record<FeedKind, FeatureKey>> = {
  quote: 'quotes',
  contract: 'contracts',
  invoice: 'bills',
};

/** Detail-page route for a clickable document, or null when there isn't one
 *  (hours have no page; emails open the preview) OR the destination's feature
 *  flag is off (so we don't render a link that just redirects away). */
function hrefFor(
  kind: FeedKind | ProjectMilestone['kind'],
  id: number | undefined,
  flags: Record<string, boolean>,
): string | null {
  if (id == null) return null;
  const flag = FLAG_FOR_KIND[kind as FeedKind];
  if (flag && !flags[flag]) return null;
  switch (kind) {
    case 'quote': return `/admin/clients/quotes/${id}`;
    case 'contract': return `/admin/clients/contracts/${id}`;
    case 'invoice': return `/admin/clients/bills/${id}`;
    case 'gallery': return `/admin/events/${id}`;
    default: return null;
  }
}

const KIND_ICON: Record<FeedKind, React.ComponentType<{ className?: string }>> = {
  email: Mail,
  quote: FileText,
  contract: ScrollText,
  invoice: Receipt,
  gallery: ImageIcon,
  hours: Clock,
};

/** Prepare the rendered email for a read-only preview:
 *  - `<base target="_blank">` so the sandboxed iframe (no allow-popups) blocks
 *    every link, preventing accidental clicks on the live Accept/Decline URLs.
 *  - `overflow-wrap:break-word` so a long unbreakable token (e.g. the gallery
 *    link) wraps inside the container instead of forcing horizontal scroll.
 *    break-word only kicks in on overflow, so it won't disturb table layout. */
function preparePreviewHtml(html: string): string {
  const inject = '<base target="_blank"><style>*{overflow-wrap:break-word}</style>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  return inject + html;
}

function minutesToHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export const ProjectCockpitPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const projectId = id ? parseInt(id, 10) : null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { flags } = useFeatureFlags();
  const { format, formatTime } = useLocalizedDate();

  const [editName, setEditName] = useState<string | null>(null);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [eventSearch, setEventSearch] = useState('');

  const { data, isLoading } = useQuery<ProjectOverview>({
    queryKey: ['project-overview', projectId],
    queryFn: () => projectsService.overview(projectId as number),
    enabled: projectId !== null,
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) => projectsService.update(projectId as number, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      setEditName(null);
      toast.success(t('projects.toast.saved', 'Project saved') as string);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('projects.toast.saveFailed', 'Save failed') as string)),
  });

  const emailActionMutation = useMutation({
    mutationFn: ({ action, emailId }: { action: 'resend' | 'cancel' | 'retry' | 'sendNow'; emailId: number }) => {
      if (action === 'resend') return projectsService.resendEmail(emailId);
      if (action === 'cancel') return projectsService.cancelEmail(emailId);
      if (action === 'retry') return projectsService.retryEmail(emailId);
      return projectsService.sendEmailNow(emailId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
      toast.success(t('projects.toast.emailAction', 'Done') as string);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('projects.toast.emailActionFailed', 'Action failed') as string)),
  });

  // Event search for the "attach event" control (results exclude events
  // already on this project).
  const { data: eventResults } = useQuery({
    queryKey: ['project-event-search', eventSearch],
    queryFn: () => eventsService.getEvents(1, 10, undefined, eventSearch),
    enabled: eventSearch.trim().length >= 2,
  });

  const attachEventMutation = useMutation({
    mutationFn: (eventId: number) => projectsService.assignEvent(projectId as number, eventId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      setEventSearch('');
      toast.success(t('projects.events.attached', 'Event attached') as string);
    },
    onError: (err: any) => {
      if (err?.response?.data?.code === 'PROJECT_CUSTOMER_MISMATCH') {
        toast.error(t('projects.error.customerMismatch', 'That belongs to a different customer than this project.') as string);
        return;
      }
      toast.error(err?.response?.data?.error || (t('projects.events.attachFailed', 'Could not attach event') as string));
    },
  });

  const openPreview = async (emailId: number) => {
    setPreviewLoading(true);
    try {
      const p = await projectsService.emailPreview(emailId);
      setPreview(p);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || (t('projects.toast.previewFailed', 'Could not load preview') as string));
    } finally {
      setPreviewLoading(false);
    }
  };

  // Merge every rolled-up document into one dated feed (newest first).
  const feed = useMemo<FeedItem[]>(() => {
    if (!data) return [];
    const items: FeedItem[] = [];
    for (const e of data.emails) {
      items.push({
        key: `email-${e.id}`, kind: 'email', date: e.sentAt || e.queuedAt,
        title: t(`projects.feed.email`, 'Email') + ` · ${e.type}`,
        subtitle: e.recipient + (e.error ? ` — ${e.error}` : ''),
        status: e.status, emailId: e.id, emailStatus: e.status, reRendered: !e.stored,
      });
    }
    for (const q of data.quotes) {
      items.push({
        key: `quote-${q.id}`, kind: 'quote', date: q.issue_date,
        title: t('projects.feed.quote', 'Quote') + ` ${q.quote_number}`,
        status: q.status, amount: formatMoneyMinor(Number(q.total_amount_minor), q.currency),
        href: hrefFor('quote', q.id, flags),
      });
    }
    for (const c of data.contracts) {
      items.push({
        key: `contract-${c.id}`, kind: 'contract', date: c.issue_date,
        title: t('projects.feed.contract', 'Contract') + ` ${c.contract_number}`,
        status: c.status, href: hrefFor('contract', c.id, flags),
      });
    }
    for (const inv of data.invoices) {
      items.push({
        key: `invoice-${inv.id}`, kind: 'invoice', date: inv.issue_date,
        title: t('projects.feed.invoice', 'Invoice') + ` ${inv.invoice_number}`,
        status: inv.status, amount: formatMoneyMinor(Number(inv.total_amount_minor), inv.currency),
        href: hrefFor('invoice', inv.id, flags),
      });
    }
    for (const ev of data.events) {
      items.push({
        key: `gallery-${ev.id}`, kind: 'gallery', date: ev.event_date,
        title: t('projects.feed.gallery', 'Gallery') + ` · ${ev.event_name}`,
        subtitle: ev.slug, href: hrefFor('gallery', ev.id, flags),
      });
    }
    for (const h of data.hours.entries) {
      items.push({
        key: `hours-${h.id}`, kind: 'hours', date: h.entry_date,
        title: t('projects.feed.hours', 'Hours') + ` · ${minutesToHours(h.duration_minutes)}`,
        subtitle: h.description || undefined, status: h.status || undefined,
      });
    }
    return items.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });
  }, [data, t, flags]);

  if (isLoading) return <Loading />;
  if (!data) return <div className="p-6 text-neutral-500">{t('projects.notFound', 'Project not found')}</div>;

  const { project, milestones, hours, valuation } = data;
  const valueBuckets = valuation?.byCurrency?.filter((b) => b.totalMinor !== 0 || b.paidMinor !== 0) || [];

  return (
    <div>
      <Link to="/admin/clients/projects" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mb-3">
        <ArrowLeft className="w-4 h-4" />{t('projects.backToList', 'All projects')}
      </Link>

      {/* Header */}
      <Card className="mb-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex-1">
            {editName === null ? (
              <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{project.name}</h1>
            ) : (
              <div className="flex items-center gap-2">
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="max-w-sm" />
                <Button variant="primary" disabled={!editName.trim() || renameMutation.isPending} onClick={() => renameMutation.mutate(editName.trim())}>
                  <Save className="w-4 h-4" />
                </Button>
                <Button variant="outline" onClick={() => setEditName(null)}><X className="w-4 h-4" /></Button>
              </div>
            )}
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
              {project.customerEmail || t('projects.noCustomer', 'No single customer')}
              {' · '}
              {t('projects.eventCount', '{{count}} events', { count: data.events.length })}
              {' · '}
              {t('projects.totalHours', '{{hours}} logged', { hours: minutesToHours(hours.totalMinutes) })}
            </p>
          </div>
          <div className="flex items-start gap-4">
            {valueBuckets.length > 0 && (
              <div className="text-right">
                <div className="text-xs text-neutral-500 dark:text-neutral-400">{t('projects.value.label', 'Project value')}</div>
                {valueBuckets.map((b) => (
                  <div key={b.currency} className="text-lg font-bold text-neutral-900 dark:text-neutral-100 tabular-nums">
                    {formatMoneyMinor(b.totalMinor, b.currency)}
                  </div>
                ))}
                {valueBuckets.some((b) => b.paidMinor !== 0) && (
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t('projects.value.paid', 'paid')}: {valueBuckets.map((b) => formatMoneyMinor(b.paidMinor, b.currency)).join(' · ')}
                  </div>
                )}
              </div>
            )}
            {editName === null && (
              <Button variant="outline" onClick={() => setEditName(project.name)}>{t('projects.rename', 'Rename')}</Button>
            )}
          </div>
        </div>
      </Card>

      {/* Events in this project + attach control */}
      <Card className="mb-4">
        <h2 className="text-sm font-semibold mb-3 text-neutral-700 dark:text-neutral-300">{t('projects.events.title', 'Events')}</h2>
        {data.events.length === 0 ? (
          <p className="text-sm text-neutral-500 mb-3">{t('projects.events.none', 'No events grouped under this project yet.')}</p>
        ) : (
          <ul className="space-y-1 mb-3">
            {data.events.map((ev) => (
              <li key={ev.id} className="flex items-center justify-between text-sm rounded-md border border-neutral-100 dark:border-neutral-800 px-3 py-1.5">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{ev.event_name}</span>
                <span className="text-xs text-neutral-500">{ev.event_date ? format(ev.event_date) : '—'}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <Input
            value={eventSearch}
            onChange={(e) => setEventSearch(e.target.value)}
            placeholder={t('projects.events.searchPlaceholder', 'Attach an event — search by name…') as string}
            className="pl-9"
          />
          {eventSearch.trim().length >= 2 && eventResults?.events && eventResults.events.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg max-h-56 overflow-auto">
              {eventResults.events
                .filter((ev: any) => !data.events.some((existing) => existing.id === ev.id))
                .map((ev: any) => (
                  <button
                    key={ev.id}
                    onClick={() => attachEventMutation.mutate(ev.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700"
                  >
                    <Plus className="w-3 h-3 text-neutral-400" />
                    <span className="flex-1 truncate text-neutral-900 dark:text-neutral-100">{ev.event_name}</span>
                    <span className="text-xs text-neutral-500">{ev.event_date ? format(ev.event_date) : ''}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </Card>

      {/* Milestone timeline */}
      {milestones && milestones.length > 0 && (
        <Card className="mb-4">
          <h2 className="text-sm font-semibold mb-3 text-neutral-700 dark:text-neutral-300">{t('projects.timeline', 'Milestones')}</h2>
          <div className="flex flex-wrap gap-3">
            {milestones.map((m, i) => {
              const Icon = KIND_ICON[m.kind] || FileText;
              const href = hrefFor(m.kind, m.id, flags);
              return (
                <div
                  key={`${m.kind}-${i}`}
                  onClick={href ? () => navigate(href) : undefined}
                  className={`flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-3 py-2 ${href ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/60' : ''}`}
                >
                  <Icon className="w-4 h-4 text-neutral-500" />
                  <div>
                    <div className="text-xs font-medium text-neutral-900 dark:text-neutral-100">{m.label}</div>
                    <div className="text-xs text-neutral-500">{m.date ? format(m.date) : '—'}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Dated feed */}
      <Card>
        <h2 className="text-sm font-semibold mb-3 text-neutral-700 dark:text-neutral-300">{t('projects.feed.title', 'Activity')}</h2>
        {feed.length === 0 ? (
          <div className="text-center py-8 text-neutral-500">{t('projects.feed.empty', 'Nothing rolled up to this project yet.')}</div>
        ) : (
          <ul className="space-y-2">
            {feed.map((item) => {
              const Icon = KIND_ICON[item.kind];
              // Whole-row click: documents navigate to their detail page,
              // emails open the preview (so the row behaves like its buttons,
              // not a dead strip next to them). Hours have neither → static.
              const onRowClick = item.href
                ? () => navigate(item.href as string)
                : (item.kind === 'email' && item.emailId != null ? () => openPreview(item.emailId as number) : undefined);
              return (
                <li
                  key={item.key}
                  onClick={onRowClick}
                  className={`flex items-start gap-3 rounded-lg border border-neutral-100 dark:border-neutral-800 px-3 py-2 ${onRowClick ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/60' : ''}`}
                >
                  <Icon className="w-4 h-4 mt-0.5 text-neutral-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{item.title}</span>
                      <span className="text-xs text-neutral-500 flex-shrink-0">
                        {item.date ? `${format(item.date)} ${item.kind === 'email' ? formatTime(item.date) : ''}` : '—'}
                      </span>
                    </div>
                    {item.subtitle && <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{item.subtitle}</div>}
                    <div className="flex items-center gap-2 mt-1">
                      {item.status && (
                        <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300">{item.status}</span>
                      )}
                      {item.amount && <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">{item.amount}</span>}
                      {item.kind === 'email' && item.emailId != null && (
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => openPreview(item.emailId as number)} className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline">
                            <Eye className="w-3 h-3" />{t('projects.email.preview', 'Preview')}
                          </button>
                          {item.reRendered && (
                            <span
                              title={t('projects.email.reRendered', 'Re-rendered from the current template — may differ slightly from what was sent.') as string}
                              className="inline-block rounded-full px-2 py-0.5 text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
                            >
                              {t('projects.email.reRenderedTag', '≈ re-rendered')}
                            </span>
                          )}
                          {item.emailStatus === 'sent' && (
                            <button onClick={() => emailActionMutation.mutate({ action: 'resend', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300 hover:underline">
                              <Send className="w-3 h-3" />{t('projects.email.resend', 'Resend')}
                            </button>
                          )}
                          {item.emailStatus === 'pending' && (
                            <>
                              <button onClick={() => emailActionMutation.mutate({ action: 'sendNow', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300 hover:underline">
                                <Send className="w-3 h-3" />{t('projects.email.sendNow', 'Send now')}
                              </button>
                              <button onClick={() => emailActionMutation.mutate({ action: 'cancel', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline">
                                <Ban className="w-3 h-3" />{t('projects.email.cancel', 'Cancel')}
                              </button>
                            </>
                          )}
                          {item.emailStatus === 'failed' && (
                            <button onClick={() => emailActionMutation.mutate({ action: 'retry', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-amber-600 hover:underline">
                              <RotateCw className="w-3 h-3" />{t('projects.email.retry', 'Retry')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Email preview modal */}
      {(preview || previewLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPreview(null)}>
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-4 py-3">
              <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">{t('projects.email.previewTitle', 'Email preview')}</h3>
              <button onClick={() => setPreview(null)} className="text-neutral-500 hover:text-neutral-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {previewLoading ? (
                <Loading />
              ) : preview && preview.available && preview.html ? (
                <>
                  {!preview.exact && (
                    <div className="mb-3 rounded-md bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                      {t('projects.email.reRendered', 'Re-rendered from the current template — this email was sent before previews were captured, so it may differ slightly from what the recipient received.')}
                    </div>
                  )}
                  {/* Read-only preview: renders the email with its own brand
                      colors (color-scheme:normal stops the dark app theme from
                      tinting it), but `sandbox` (no allow-popups/scripts/forms)
                      + neutralizeLinks make every link inert — so the admin
                      can't accidentally trigger the live Accept/Decline URLs by
                      clicking inside the preview. Scrolling still works. */}
                  <iframe
                    title="email-preview"
                    srcDoc={preparePreviewHtml(preview.html)}
                    sandbox=""
                    style={{ colorScheme: 'normal' }}
                    className="w-full h-[60vh] border border-neutral-200 dark:border-neutral-700 rounded"
                  />
                </>
              ) : (
                <div className="text-center py-10 text-neutral-500">
                  {t('projects.email.noPreview', 'No stored preview for this email — it was sent before previews were captured.')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
