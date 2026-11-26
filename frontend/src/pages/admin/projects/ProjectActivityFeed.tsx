/**
 * The project's Activity tab: one dated feed merging every email (with the
 * actual sent HTML preview + resend/cancel/retry/send-now actions), quote,
 * contract, invoice, gallery and logged hour that rolls up to the project.
 * Moved here unchanged from the Overview, which now shows the stages.
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  Mail, FileText, ScrollText, Receipt, Image as ImageIcon, Clock,
  Send, RotateCw, Ban, Eye,
} from 'lucide-react';
import { Badge, Card, EmptyState, Loading, Modal, Notice } from '../../../components/common';
import {
  projectsService,
  type ProjectOverview,
  type EmailPreview,
} from '../../../services/projects.service';
import { toDisplayDate, useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../../hooks';
import { formatMoneyMinor } from '../../../utils/money';
import { type FeatureKey } from '../../../contexts/FeatureFlagsContext';

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
  /** Server's verdict on whether the queued-mail routes would accept an action
   *  on this row. Not derivable client-side — see canActOnEmail. */
  emailCanAct?: boolean;
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
  kind: FeedKind,
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

export function minutesToHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export const ProjectActivityFeed: React.FC<{
  data: ProjectOverview;
  flags: Record<string, boolean>;
  canSendEmail: boolean;
}> = ({ data, flags, canSendEmail }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { format, formatTime } = useLocalizedDate();
  const projectId = data.project.id;
  // Which email controls are actually reachable for THIS admin, so the feed
  // stops offering buttons the API will reject (#969):
  //   404 — requireOwnedQueuedEmail (adminProjects.js) scopes queued mail
  //         through email_queue.event_id AND ownership of that event. CRM
  //         document mail carries no event_id at all. The server decides this
  //         for us (`canAct`) because neither half is derivable here: the
  //         overview deliberately does not expose who owns a sibling event.
  //         Absent (older backend) → treat as not actionable, so we fail to
  //         hiding a live control rather than offering a dead one.
  //   403 — preview needs `events.view`, but resend/cancel/retry/send-now
  //         need `email.send`; the feed used to render all four regardless.
  const canActOnEmail = (item: FeedItem) => item.emailCanAct === true;

  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const emailActionMutation = useMutationWithToast({
    mutationFn: ({ action, emailId }: { action: 'resend' | 'cancel' | 'retry' | 'sendNow'; emailId: number }) => {
      if (action === 'resend') return projectsService.resendEmail(emailId);
      if (action === 'cancel') return projectsService.cancelEmail(emailId);
      if (action === 'retry') return projectsService.retryEmail(emailId);
      return projectsService.sendEmailNow(emailId);
    },
    successMessage: t('projects.toast.emailAction', 'Done') as string,
    invalidateKeys: [['project-overview', projectId]],
    errorMessage: t('projects.toast.emailActionFailed', 'Action failed') as string,
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
        subtitle: [e.recipient, e.error].filter(Boolean).join(' — '),
        status: e.status, emailId: e.id, emailStatus: e.status, reRendered: !e.stored,
        emailCanAct: e.canAct,
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
    // Ordered by the reading the row prints: the date hook's parser takes
    // SQLite's zone-less created_at of a queued mail as UTC (issue 1815).
    // The outer `new Date` is for the other shape SQLite sends, epoch
    // milliseconds, which that parser hands back as the number it got.
    return items.sort((a, b) => {
      const da = a.date ? new Date(toDisplayDate(a.date)).getTime() : 0;
      const db = b.date ? new Date(toDisplayDate(b.date)).getTime() : 0;
      return db - da;
    });
  }, [data, t, flags]);

  return (
    <>
      {/* Dated feed */}
      <Card>
        <h2 className="text-sm font-semibold mb-3 text-body">{t('projects.feed.title', 'Activity')}</h2>
        {feed.length === 0 ? (
          <div className="text-center py-8 text-muted">{t('projects.feed.empty', 'Nothing rolled up to this project yet.')}</div>
        ) : (
          <ul className="space-y-2">
            {feed.map((item) => {
              const Icon = KIND_ICON[item.kind];
              // Whole-row click: documents navigate to their detail page,
              // emails open the preview (so the row behaves like its buttons,
              // not a dead strip next to them). Hours have neither → static.
              const onRowClick = item.href
                ? () => navigate(item.href as string)
                : (item.kind === 'email' && item.emailId != null && canActOnEmail(item)
                  ? () => openPreview(item.emailId as number)
                  : undefined);
              return (
                <li
                  key={item.key}
                  onClick={onRowClick}
                  className={`flex items-start gap-3 rounded-lg border border-line-faint px-3 py-2 ${onRowClick ? 'cursor-pointer hover:bg-hover-soft' : ''}`}
                >
                  <Icon className="w-4 h-4 mt-0.5 text-muted flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-heading truncate">{item.title}</span>
                      <span className="text-xs text-muted flex-shrink-0">
                        {item.date ? `${format(item.date)} ${item.kind === 'email' ? formatTime(item.date) : ''}` : '—'}
                      </span>
                    </div>
                    {item.subtitle && <div className="text-xs text-muted truncate">{item.subtitle}</div>}
                    <div className="flex items-center gap-2 mt-1">
                      {item.status && (
                        <Badge>{item.status}</Badge>
                      )}
                      {item.amount && <span className="text-xs font-medium text-body">{item.amount}</span>}
                      {item.kind === 'email' && item.emailId != null && canActOnEmail(item) && (
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => openPreview(item.emailId as number)} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                            <Eye className="w-3 h-3" />{t('projects.email.preview', 'Preview')}
                          </button>
                          {item.reRendered && (
                            <Badge
                              tone="warning"
                              title={t('projects.email.reRendered', 'Re-rendered from the current template — may differ slightly from what was sent.') as string}
                            >
                              {t('projects.email.reRenderedTag', '≈ re-rendered')}
                            </Badge>
                          )}
                          {canSendEmail && item.emailStatus === 'sent' && (
                            <button onClick={() => emailActionMutation.mutate({ action: 'resend', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-body hover:underline">
                              <Send className="w-3 h-3" />{t('projects.email.resend', 'Resend')}
                            </button>
                          )}
                          {canSendEmail && item.emailStatus === 'pending' && (
                            <>
                              <button onClick={() => emailActionMutation.mutate({ action: 'sendNow', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-body hover:underline">
                                <Send className="w-3 h-3" />{t('projects.email.sendNow', 'Send now')}
                              </button>
                              <button onClick={() => emailActionMutation.mutate({ action: 'cancel', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-danger-text hover:underline">
                                <Ban className="w-3 h-3" />{t('projects.email.cancel', 'Cancel')}
                              </button>
                            </>
                          )}
                          {canSendEmail && item.emailStatus === 'failed' && (
                            <button onClick={() => emailActionMutation.mutate({ action: 'retry', emailId: item.emailId as number })} className="inline-flex items-center gap-1 text-xs text-warning-text hover:underline">
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
      <Modal
        open={!!(preview || previewLoading)}
        onClose={() => setPreview(null)}
        title={t('projects.email.previewTitle', 'Email preview')}
        size="lg"
      >
        {previewLoading ? (
          <Loading />
        ) : preview && preview.available && preview.html ? (
          <>
            {!preview.exact && (
              <Notice tone="warning" size="sm" className="mb-3">
                {t('projects.email.reRendered', 'Re-rendered from the current template — this email was sent before previews were captured, so it may differ slightly from what the recipient received.')}
              </Notice>
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
              className="w-full h-[60vh] border border-line rounded"
            />
          </>
        ) : (
          <EmptyState
            size="inline"
            title={t('projects.email.noPreview', 'No stored preview for this email — it was sent before previews were captured.')}
          />
        )}
      </Modal>
    </>
  );
};
