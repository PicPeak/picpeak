/**
 * Everything the project holds, grouped by the stage it belongs to: quotes,
 * contracts, galleries, invoices. Each row opens its document. An empty
 * group is a button that opens the search to add
 * an existing one (AttachDocumentDialog); a group with rows has "Add" in its
 * heading.
 */
import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Image as ImageIcon, Plus, Receipt, ScrollText, Unlink } from 'lucide-react';
import { Badge, Card, type BadgeTone } from '../../../components/common';
import { projectsService, type ProjectOverview } from '../../../services/projects.service';
import type { AttachKind } from './AttachDocumentDialog';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../../utils/money';
import { QUOTE_STATUS_TONE } from '../../../utils/quoteStatus';

const CONTRACT_TONE: Record<string, BadgeTone> = {
  draft: 'neutral', sent: 'info', awaiting_data: 'info', signed_by_customer: 'info', signed_by_admin: 'info',
  fully_signed: 'success', cancelled: 'danger', declined: 'danger', expired: 'warning',
};
const INVOICE_TONE: Record<string, BadgeTone> = {
  scheduled: 'neutral', draft: 'neutral', pending_delivery: 'warning', sent: 'info', paid: 'success',
  overdue: 'danger', cancelled: 'storno', skipped: 'neutral',
};
const truthy = (v: unknown) => v === true || v === 1 || v === '1';

interface Props {
  data: ProjectOverview;
  flags: Record<string, boolean>;
  can: (perm: string) => boolean;
  canAttachGallery: boolean;
  /** May add quotes and contracts (documentsLinkable plus the manage permission). */
  canAttachQuote: boolean;
  canAttachContract: boolean;
  canAttachInvoice: boolean;
  /** Opens the search window (AttachDocumentDialog, rendered by the page). */
  onAdd: (kind: AttachKind) => void;
}

const Row: React.FC<{
  icon: React.ReactNode; title: string; subtitle?: string; badge?: React.ReactNode; amount?: string; href?: string | null;
  /** A small control next to the row (it cannot sit inside the row's button). */
  action?: React.ReactNode;
}> = ({ icon, title, subtitle, badge, amount, href, action }) => {
  const navigate = useNavigate();
  const body = (
    <>
      <span className="w-8 h-8 rounded-lg grid place-items-center bg-inset text-soft shrink-0">{icon}</span>
      <span className="flex-1 min-w-[10rem]">
        <span className="block text-sm font-semibold text-heading truncate">{title}</span>
        {subtitle && <span className="block text-xs text-muted truncate">{subtitle}</span>}
      </span>
      {badge}
      {amount && <span className="text-sm font-semibold text-heading tabular-nums">{amount}</span>}
    </>
  );
  const cls = 'w-full flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-3 py-2.5 text-left';
  const row = href ? (
    <button type="button" onClick={() => navigate(href)} className={`${cls} hover:bg-hover-soft`}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
  return action ? <div className="flex items-stretch gap-1.5">{row}{action}</div> : row;
};

const Group: React.FC<{ title: string; empty: string; addLabel?: string; onAdd?: () => void; children?: React.ReactNode }> = ({ title, empty, addLabel, onAdd, children }) => {
  const rows = React.Children.toArray(children).filter(Boolean);
  const emptyCls = 'w-full rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-left text-sm text-muted';
  return (
    <section>
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {onAdd && rows.length > 0 && (
          <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            <Plus className="w-3 h-3" />{addLabel}
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {rows.length ? rows : onAdd ? (
          <button type="button" onClick={onAdd} className={`${emptyCls} flex flex-wrap items-center gap-x-3 gap-y-1 hover:border-accent hover:text-heading`}>
            <span>{empty}</span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-accent"><Plus className="w-3 h-3" />{addLabel}</span>
          </button>
        ) : (
          <p className={emptyCls}>{empty}</p>
        )}
      </div>
    </section>
  );
};

export const ProjectDocumentsCard: React.FC<Props> = ({ data, flags, can, canAttachGallery, canAttachQuote, canAttachContract, canAttachInvoice, onAdd }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const addLabel = t('projects.attach.add', 'Add existing') as string;
  const qc = useQueryClient();
  const projectId = data.project.id;
  // Taking an invoice out is an action (UX.md › Settings vs actions): at once,
  // with a toast, and undone by adding it again.
  const takeOut = useMutation({
    mutationFn: (invoiceId: number) => projectsService.unassignInvoice(projectId, invoiceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('projects.attach.takenOut', 'Taken out of the project') as string);
    },
    onError: (err: unknown) => {
      const res = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(res?.error || (t('projects.attach.takeOutFailed', 'Could not take it out of the project') as string));
    },
  });

  const link = (flag: string, href: string) => (flags[flag] ? href : null);
  // A group the admin cannot have (feature off, or no view permission: the
  // overview leaves those documents out) is not shown as "none yet".
  const shows = (flag: string, perm: string) => !!flags[flag] && can(perm);
  // Nor is a group whose stage this project skips, while it holds nothing:
  // the stage strip already says "skipped". The gallery group stays, so a
  // gallery can still be added.
  const skipped = (key: string, count: number) => count === 0
    && data.stage?.stages.some((s) => s.key === key && s.state === 'skipped');
  const date = (d: string | null | undefined) => (d ? format(d) : '');

  return (
    <Card>
      <h2 className="text-base font-semibold text-heading mb-4">{t('projects.documents.title', 'Documents & galleries')}</h2>
      <div className="space-y-5">
        {shows('quotes', 'quotes.view') && !skipped('quote', data.quotes.length) && (
        <Group title={t('projects.stage.quote', 'Quote')} empty={t('projects.documents.noQuote', 'No quote yet.')}
          addLabel={addLabel} onAdd={canAttachQuote ? () => onAdd('quote') : undefined}>
          {data.quotes.map((q) => (
            <Row
              key={q.id}
              icon={<FileText className="w-4 h-4" />}
              title={q.quote_number}
              subtitle={date(q.issue_date)}
              badge={<Badge tone={QUOTE_STATUS_TONE[q.status] ?? 'neutral'}>{t(`quotes.status.${q.status}`, q.status)}</Badge>}
              amount={formatMoneyMinor(Number(q.total_amount_minor), q.currency)}
              href={link('quotes', `/admin/clients/quotes/${q.id}`)}
            />
          ))}
        </Group>
        )}

        {shows('contracts', 'contracts.view') && !skipped('contract', data.contracts.length) && (
        <Group title={t('projects.stage.contract', 'Contract')} empty={t('projects.documents.noContract', 'No contract yet.')}
          addLabel={addLabel} onAdd={canAttachContract ? () => onAdd('contract') : undefined}>
          {data.contracts.map((c) => (
            <Row
              key={c.id}
              icon={<ScrollText className="w-4 h-4" />}
              title={c.contract_number}
              subtitle={c.signed_by_customer_at
                ? t('projects.documents.signedOn', 'signed on {{date}}', { date: date(c.signed_by_customer_at) })
                : date(c.issue_date)}
              badge={<Badge tone={CONTRACT_TONE[c.status] ?? 'neutral'}>{t(`contracts.status.${c.status}`, c.status)}</Badge>}
              href={link('contracts', `/admin/clients/contracts/${c.id}`)}
            />
          ))}
        </Group>
        )}

        <Group
          title={t('projects.stage.gallery', 'Gallery')}
          empty={t('projects.documents.noGallery', 'No gallery yet.')}
          addLabel={addLabel}
          onAdd={canAttachGallery ? () => onAdd('gallery') : undefined}
        >
          {data.events.map((ev) => (
            <Row
              key={ev.id}
              icon={<ImageIcon className="w-4 h-4" />}
              title={ev.event_name}
              subtitle={date(ev.event_date)}
              badge={truthy(ev.is_archived)
                ? <Badge tone="neutral">{t('events.archived', 'Archived')}</Badge>
                : truthy(ev.is_draft)
                  ? <Badge tone="warning">{t('projects.documents.draft', 'Draft')}</Badge>
                  : <Badge tone="success">{t('projects.documents.published', 'Published')}</Badge>}
              href={`/admin/events/${ev.id}`}
            />
          ))}
        </Group>

        {shows('bills', 'bills.view') && !skipped('invoice', data.invoices.length) && (
        <Group title={t('projects.documents.invoices', 'Invoices')} empty={t('projects.documents.noInvoice', 'No invoice yet.')}
          addLabel={addLabel} onAdd={canAttachInvoice ? () => onAdd('invoice') : undefined}>
          {data.invoices.map((inv) => (
            <Row
              key={inv.id}
              icon={<Receipt className="w-4 h-4" />}
              title={inv.invoice_number}
              subtitle={inv.paid_at
                ? t('projects.documents.paidOn', 'paid on {{date}}', { date: date(inv.paid_at) })
                : date(inv.issue_date)}
              badge={<Badge tone={INVOICE_TONE[inv.status] ?? 'neutral'}>{t(`bills.status.${inv.status}`, inv.status)}</Badge>}
              amount={formatMoneyMinor(Number(inv.total_amount_minor), inv.currency)}
              href={link('bills', `/admin/clients/bills/${inv.id}`)}
              action={canAttachInvoice && inv.direct ? (
                <button
                  type="button"
                  onClick={() => takeOut.mutate(inv.id)}
                  disabled={takeOut.isPending}
                  title={t('projects.attach.takeOut', 'Take out of the project') as string}
                  aria-label={t('projects.attach.takeOutNamed', 'Take {{number}} out of the project', { number: inv.invoice_number }) as string}
                  className="shrink-0 w-10 grid place-items-center rounded-xl border border-line text-soft hover:text-heading hover:bg-hover-soft disabled:opacity-60"
                >
                  <Unlink className="w-4 h-4" />
                </button>
              ) : undefined}
            />
          ))}
        </Group>
        )}
      </div>
    </Card>
  );
};
