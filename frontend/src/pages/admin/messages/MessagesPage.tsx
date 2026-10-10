import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  Inbox, Send, Reply, ReplyAll, Forward, Archive, Trash2, Paperclip,
  FileText, Quote, FileSignature, Image as ImageIcon, ReceiptText,
  Link2, ChevronLeft, ChevronRight, Mail, RefreshCw, PenSquare, Search, RotateCcw, type LucideIcon,
} from 'lucide-react';
import { emailService, type ReceivedEmail, type MailIdentities } from '../../../services/email.service';
import { accountingService } from '../../../services/accounting.service';
import { Badge, Button, Loading, Modal, useConfirm } from '../../../components/common';
import type { BadgeTone } from '../../../components/common';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';
import { useFillViewport } from '../../../components/admin/fillViewport';
import { MessageComposer, type ComposerInit } from './MessageComposer';
import { DocumentActionModal, type DocType } from './DocumentActionModal';
import { EmailBodyFrame } from './EmailBodyFrame';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { usePermission } from '../../../hooks/usePermission';

/**
 * Admin "Messages" — read-only viewer over the mail picpeak already
 * has: the Automated stream (email_queue, incl. rendered bodies from migration
 * 119) and the Accounting inbox (received_emails / supplier invoices). The
 * Customers (hello@) mailbox and reply/compose land in later phases; those
 * folders render an explanatory empty state so the full IA is visible now.
 */

type FolderSrc = 'queue' | 'received' | 'empty' | 'state';
interface Folder { id: string; name: string; icon: LucideIcon; src: FolderSrc; account?: string; origin?: 'system' | 'manual'; state?: 'archived' | 'deleted'; note?: string; }
interface Account { id: string; name: string; addr?: string; color: string; folders: Folder[]; }

type Selection =
  | { kind: 'queue'; id: number }
  | { kind: 'received'; item: ReceivedEmail }
  | null;

const TYPE_LABELS: Record<string, string> = {
  invoice_sent: 'Invoice sent',
  invoice_reminder_first: 'Payment reminder',
  invoice_reminder_second: 'Payment reminder',
  invoice_reminder_final: 'Final reminder',
  invoice_payment_check: 'Payment check',
  invoice_collections_handoff: 'Collections handoff',
  invoice_paid_admin_notification: 'Payment received',
  expiration_warning: 'Gallery expiring',
  gallery_expired: 'Gallery expired',
  quote_sent: 'Quote sent',
  contract_sent: 'Contract sent',
};
const friendlyType = (t: string) =>
  TYPE_LABELS[t] || t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

// Compact mailbox label — just the local part + '@' (the domain clutters the
// narrow sidebar); full address stays in the hover title.
const localPart = (addr?: string | null) => (addr ? `${addr.split('@')[0]}@` : '');

// Escape untrusted text before it goes into an HTML string. The inbound From
// header carries an attacker-controlled display name; the reply stub builds raw
// HTML for the (contentEditable) composer, so this MUST be escaped there.
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]));

// A From/To header can be "Display Name <addr@x>" — pull the bare address for
// use as a recipient / customer-lookup key.
const extractEmail = (addr?: string | null) => {
  if (!addr) return '';
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
};

const STATUS_TONES: Record<string, BadgeTone> = {
  sent: 'success',
  ingested: 'success',
  received: 'info',
  pending: 'warning',
  failed: 'danger',
  error: 'danger',
};

export const MessagesPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  // The three panes scroll on their own from lg up (STYLING.md › Split views).
  useFillViewport();
  // Archive / Restore / Delete write the shared folders, which the backend
  // guards with email.edit; email.view alone reads the page.
  const canEditMailbox = usePermission('email.edit');
  const [activeFolder, setActiveFolder] = useState('auto-sent');
  const [selection, setSelection] = useState<Selection>(null);
  const [pdfDocId, setPdfDocId] = useState<number | null>(null);
  const [composer, setComposer] = useState<{ init: ComposerInit; title?: string; accountKey?: string } | null>(null);
  const [docAction, setDocAction] = useState<{ docType: DocType; senderEmail: string } | null>(null);
  const { flags } = useFeatureFlags();
  const [search, setSearch] = useState('');
  // Debounced copy drives the server-side search (so results aren't truncated to
  // the first page); the raw `search` still filters the loaded rows instantly.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  const sq = debouncedSearch || undefined;

  // "Sync" = poll the inbound mailboxes now instead of waiting for the 60s loop.
  const sync = useMutation({
    mutationFn: () => emailService.pollIncoming(),
    onSuccess: (r) => {
      if (r.skipped === 'disabled') toast.info(t('messages.syncDisabled', 'Incoming mail is off — enable it under Settings → Features.'));
      else if (r.skipped === 'unconfigured') toast.info(t('messages.syncUnconfigured', 'Configure a mailbox under Settings → Email first.'));
      else if (r.skipped === 'busy') toast.info(t('messages.syncBusy', 'A sync is already running.'));
      else toast.success(t('messages.syncOk', 'Checked mailboxes — {{count}} new.', { count: r.processed || 0 }));
      acctQuery.refetch(); custQuery.refetch(); queueQuery.refetch();
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('messages.syncFailed', 'Sync failed.')),
  });

  const openNewMessage = () => setComposer({
    init: { to: '', subject: '', html: '' },
    title: t('messages.newMessage', 'New message'),
    accountKey: 'customers',
  });

  const queueQuery = useQuery({
    queryKey: ['messages', 'queue', sq],
    queryFn: () => emailService.listQueue({ pageSize: 100, q: sq }),
    refetchInterval: 60000,
  });
  const acctQuery = useQuery({
    queryKey: ['messages', 'received', 'accounting', sq],
    queryFn: () => emailService.listReceived({ account: 'accounting', pageSize: 100, q: sq }),
    refetchInterval: 60000,
  });
  const custQuery = useQuery({
    queryKey: ['messages', 'received', 'customers', sq],
    queryFn: () => emailService.listReceived({ account: 'customers', pageSize: 100, q: sq }),
    refetchInterval: 60000,
  });

  const identitiesQuery = useQuery({
    queryKey: ['messages', 'identities'],
    queryFn: () => emailService.getIdentities(),
  });
  const identities = identitiesQuery.data;

  // Archived / Deleted system folders — fetch queue + received for that state,
  // on demand (only when the folder is open).
  const folderState: 'archived' | 'deleted' | undefined =
    activeFolder === 'archived' ? 'archived' : activeFolder === 'deleted' ? 'deleted' : undefined;
  const stateQueueQuery = useQuery({
    queryKey: ['messages', 'state-queue', folderState, sq],
    enabled: !!folderState,
    queryFn: () => emailService.listQueue({ state: folderState as 'archived' | 'deleted', pageSize: 100, q: sq }),
  });
  const stateRecvQuery = useQuery({
    queryKey: ['messages', 'state-received', folderState, sq],
    enabled: !!folderState,
    queryFn: () => emailService.listReceived({ state: folderState as 'archived' | 'deleted', pageSize: 100, q: sq }),
  });

  const refetchAll = () => {
    queueQuery.refetch(); acctQuery.refetch(); custQuery.refetch();
    stateQueueQuery.refetch(); stateRecvQuery.refetch();
  };
  const stateMut = useMutation({
    mutationFn: (v: { kind: 'queue' | 'received'; id: number; state: 'active' | 'archived' | 'deleted' }) =>
      emailService.setItemState(v.kind, v.id, v.state),
    onSuccess: () => { setSelection(null); refetchAll(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('messages.actionFailed', 'Action failed.')),
  });
  const purgeMut = useMutation({
    mutationFn: (v: { kind: 'queue' | 'received'; id: number }) => emailService.deleteItem(v.kind, v.id),
    onSuccess: () => { setSelection(null); refetchAll(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('messages.actionFailed', 'Action failed.')),
  });
  // Archive / Delete (soft) / Restore, acting on the current selection. Delete
  // from the Deleted folder is permanent.
  const doItemAction = async (action: 'archive' | 'delete' | 'restore') => {
    if (!selection) return;
    const kind = selection.kind;
    const id = selection.kind === 'queue' ? selection.id : selection.item.id;
    if (action === 'restore') stateMut.mutate({ kind, id, state: 'active' });
    else if (action === 'archive') stateMut.mutate({ kind, id, state: 'archived' });
    else if (folderState === 'deleted') {
      // The one step here that cannot be undone: everything else moves the
      // message between folders.
      const ok = await confirm({
        title: t('messages.deleteForeverTitle', 'Delete this message permanently?'),
        message: t('messages.deleteForeverConfirm', 'The message and its attachments are removed for good. This cannot be undone.'),
        variant: 'danger',
        confirmLabel: t('messages.deleteForever', 'Delete permanently'),
      });
      if (ok) purgeMut.mutate({ kind, id });
    }
    else stateMut.mutate({ kind, id, state: 'deleted' });
  };

  const queueTotal = queueQuery.data?.pagination.total;
  const acctTotal = acctQuery.data?.pagination.total;
  const custTotal = custQuery.data?.pagination.total;

  const accounts: Account[] = useMemo(() => [
    { id: 'all', name: t('messages.account.all', 'All mail'), color: 'var(--ui-text-faint)', folders: [
      { id: 'all-in', name: t('messages.folder.inbox', 'Inbox'), icon: Inbox, src: 'received' },
      { id: 'all-sent', name: t('messages.folder.sent', 'Sent'), icon: Send, src: 'queue' },
    ] },
    { id: 'cust', name: t('messages.account.customers', 'Customers'), addr: identities?.customers || undefined, color: 'var(--chart-1)', folders: [
      { id: 'cust-in', name: t('messages.folder.inbox', 'Inbox'), icon: Inbox, src: 'received', account: 'customers' },
      { id: 'cust-sent', name: t('messages.folder.sent', 'Sent'), icon: Send, src: 'queue', origin: 'manual' },
    ] },
    { id: 'acct', name: t('messages.account.accounting', 'Accounting'), addr: identities?.accounting || undefined, color: 'var(--chart-2)', folders: [
      { id: 'acct-in', name: t('messages.folder.inbox', 'Inbox'), icon: Inbox, src: 'received', account: 'accounting' },
    ] },
    { id: 'auto', name: t('messages.account.automated', 'Automated'), addr: identities?.automated || undefined, color: 'var(--chart-4)', folders: [
      { id: 'auto-sent', name: t('messages.folder.sent', 'Sent'), icon: Send, src: 'queue', origin: 'system' },
    ] },
  ], [t, identities]);

  // Cross-account system folders — Archived + Deleted (trash).
  const systemFolders: Folder[] = useMemo(() => [
    { id: 'archived', name: t('messages.folder.archived', 'Archived'), icon: Archive, src: 'state', state: 'archived' },
    { id: 'deleted', name: t('messages.folder.deleted', 'Deleted'), icon: Trash2, src: 'state', state: 'deleted' },
  ], [t]);

  // Sent stream is split client-side by origin: system (Automated) vs manual
  // (human composed → Customers ▸ Sent). Legacy rows (origin undefined) = system.
  const queueItemsAll = queueQuery.data?.items || [];
  const queueFor = (origin?: 'system' | 'manual') =>
    origin === 'manual' ? queueItemsAll.filter((i) => i.origin === 'manual')
      : origin === 'system' ? queueItemsAll.filter((i) => i.origin !== 'manual')
        : queueItemsAll;

  const folder = useMemo(() => {
    for (const a of accounts) for (const f of a.folders) if (f.id === activeFolder) return { a, f };
    const sf = systemFolders.find((f) => f.id === activeFolder);
    if (sf) return { a: { id: 'system', name: sf.name, color: 'var(--ui-text-faint)', folders: [] } as Account, f: sf };
    return { a: accounts[0], f: accounts[0].folders[0] };
  }, [accounts, systemFolders, activeFolder]);

  const countFor = (f: Folder): number | undefined => {
    if (f.src === 'queue') return f.origin ? queueFor(f.origin).length : queueTotal;
    if (f.src === 'received') {
      if (f.account === 'customers') return custTotal;
      if (f.account === 'accounting') return acctTotal;
      return (acctTotal || 0) + (custTotal || 0);
    }
    return undefined;
  };

  // Which received rows feed the active folder (customer / accounting / union).
  const receivedItems = useMemo(() => {
    if (folder.f.src !== 'received') return undefined;
    const a = acctQuery.data?.items || [];
    const c = custQuery.data?.items || [];
    if (folder.f.account === 'customers') return c;
    if (folder.f.account === 'accounting') return a;
    return [...a, ...c].sort((x, y) => (y.received_at || '').localeCompare(x.received_at || ''));
  }, [folder, acctQuery.data, custQuery.data]);

  const receivedLoading = folder.f.account === 'customers'
    ? custQuery.isLoading
    : folder.f.account === 'accounting'
      ? acctQuery.isLoading
      : acctQuery.isLoading || custQuery.isLoading;

  return (
    <div className="flex flex-col lg:flex-1 lg:min-h-0">
      <SectionPageHeader
        icon={Mail}
        title={t('messages.title', 'Messages')}
        description={t('messages.subtitle', 'Sent, automated and incoming mail — one place.')}
        feature="messaging"
        className="mb-3 flex-none"
        actions={(
          <>
            <div className="relative w-full sm:w-64 min-w-0">
              <Search className="w-4 h-4 text-faint absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('messages.searchPlaceholder', 'Search this folder…')}
                aria-label={t('messages.searchPlaceholder', 'Search this folder…')}
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-line-strong bg-subtle text-sm text-heading focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              leftIcon={<RefreshCw className={`w-4 h-4 ${sync.isPending ? 'animate-spin' : ''}`} />}
            >
              {t('messages.sync', 'Sync')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={openNewMessage}
              leftIcon={<PenSquare className="w-4 h-4" />}
            >
              {t('messages.newMessage', 'New message')}
            </Button>
          </>
        )}
      />

      <div className="flex flex-1 min-h-[540px] lg:min-h-0 rounded-xl border border-line-faint overflow-hidden bg-shell">
        {/* ── account tree ── */}
        <nav className="w-56 flex-none border-r border-line-faint overflow-y-auto p-2 bg-canvas">
          {accounts.map((a) => (
            <div key={a.id} className="mb-1.5">
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm font-semibold text-body">
                <span className="w-2 h-2 rounded-full flex-none" style={{ background: a.color }} />
                <span>{a.name}</span>
                {a.addr && <span title={a.addr} className="ml-auto text-[11px] font-medium font-mono text-faint truncate max-w-[7rem]">{localPart(a.addr)}</span>}
              </div>
              <div className="flex flex-col gap-0.5">
                {a.folders.map((f) => {
                  const c = countFor(f);
                  const active = f.id === activeFolder;
                  return (
                    <button
                      key={f.id}
                      onClick={() => { setActiveFolder(f.id); setSelection(null); }}
                      className={`flex items-center gap-2 pl-7 pr-2 py-1.5 rounded-lg text-[13.5px] text-left transition-colors ${
                        active
                          ? 'bg-accent-soft text-on-accent-soft font-semibold'
                          : 'text-soft hover:bg-hover'
                      }`}
                    >
                      <f.icon className="w-4 h-4 opacity-80" />
                      <span>{f.name}</span>
                      {typeof c === 'number' && c > 0 && (
                        <span className={`ml-auto tabular-nums text-xs ${active ? 'text-on-accent-soft' : 'text-faint'}`}>{c}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {/* System folders — Archived + Deleted, across all accounts. */}
          <div className="mt-2 pt-2 border-t border-line-faint flex flex-col gap-0.5">
            {systemFolders.map((f) => {
              const active = f.id === activeFolder;
              return (
                <button
                  key={f.id}
                  onClick={() => { setActiveFolder(f.id); setSelection(null); }}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13.5px] text-left transition-colors ${
                    active
                      ? 'bg-accent-soft text-on-accent-soft font-semibold'
                      : 'text-soft hover:bg-hover'
                  }`}
                >
                  <f.icon className="w-4 h-4 opacity-80" />
                  <span>{f.name}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* ── message list ── */}
        <section className="w-[22rem] flex-none flex flex-col min-h-0 border-r border-line-faint">
          <div className="px-4 py-3 border-b border-line-faint flex-none">
            <div className="text-base font-semibold text-heading">{folder.f.name}</div>
            <div className="text-xs text-muted mt-0.5">
              {folder.f.src === 'state'
                ? t('messages.acrossAccounts', 'Across all accounts')
                : folder.a.addr || (folder.a.id === 'all' ? t('messages.unified', 'Unified across accounts') : t('messages.systemGenerated', 'System-generated'))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <MessageList
              folder={folder.f}
              queue={folder.f.src === 'state' ? stateQueueQuery.data?.items : queueFor(folder.f.origin)}
              received={folder.f.src === 'state' ? stateRecvQuery.data?.items : receivedItems}
              loading={folder.f.src === 'state'
                ? (stateQueueQuery.isLoading || stateRecvQuery.isLoading)
                : folder.f.src === 'queue' ? queueQuery.isLoading : folder.f.src === 'received' ? receivedLoading : false}
              search={search}
              selection={selection}
              onSelect={setSelection}
              t={t}
            />
          </div>
        </section>

        {/* ── reading pane ── */}
        <section className="flex-1 min-w-0 flex flex-col min-h-0">
          <ReadingPane
            selection={selection}
            account={folder.a}
            identities={identities}
            flags={flags}
            folderState={folderState}
            onViewDoc={setPdfDocId}
            onOpenAccounting={() => navigate('/admin/accounting/inbox')}
            onCompose={(init, title) => setComposer({ init, title, accountKey: 'customers' })}
            onOpenDoc={(docType, senderEmail) => setDocAction({ docType, senderEmail })}
            onItemAction={doItemAction}
            canEdit={canEditMailbox}
            t={t}
          />
        </section>
      </div>

      {pdfDocId != null && <PdfModal docId={pdfDocId} onClose={() => setPdfDocId(null)} t={t} />}
      {composer && (
        <MessageComposer
          init={composer.init}
          title={composer.title}
          accountKey={composer.accountKey}
          onClose={() => setComposer(null)}
          onSent={() => { queueQuery.refetch(); setActiveFolder('cust-sent'); }}
          t={t}
        />
      )}
      {docAction && (
        <DocumentActionModal
          docType={docAction.docType}
          senderEmail={docAction.senderEmail}
          onCompose={(init) => { setDocAction(null); setComposer({ init: { to: init.to, subject: init.subject, html: init.html }, title: init.subject, accountKey: 'customers' }); }}
          onClose={() => setDocAction(null)}
          t={t}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────── message list ──
const MessageList: React.FC<{
  folder: Folder;
  queue?: import('../../../services/email.service').EmailQueueItem[];
  received?: ReceivedEmail[];
  loading: boolean;
  search: string;
  selection: Selection;
  onSelect: (s: Selection) => void;
  t: TFunction;
}> = ({ folder, queue, received, loading, search, selection, onSelect, t }) => {
  if (folder.src === 'empty') {
    return (
      <div className="p-8 text-center text-sm text-muted">
        <Inbox className="w-8 h-8 mx-auto mb-3 text-faint" />
        {folder.note}
      </div>
    );
  }
  if (loading) return <div className="p-6"><Loading /></div>;

  const qRows = (queue || []).map((m) => ({
    key: `q${m.id}`,
    sortKey: m.sentAt || m.createdAt || '',
    onClick: () => onSelect({ kind: 'queue', id: m.id }),
    active: selection?.kind === 'queue' && selection.id === m.id,
    who: m.recipientEmail,
    subject: friendlyType(m.emailType),
    when: fmt(m.sentAt || m.createdAt),
    status: m.status,
    attach: 0,
  }));
  const rRows = (received || []).map((m) => ({
    key: `r${m.id}`,
    sortKey: m.received_at || '',
    onClick: () => onSelect({ kind: 'received', item: m }),
    active: selection?.kind === 'received' && selection.item.id === m.id,
    who: m.from_address || '—',
    subject: m.subject || t('messages.noSubject', '(no subject)'),
    when: fmt(m.received_at),
    status: m.status,
    attach: m.attachment_count,
  }));

  // Archived/Deleted folders (src 'state') merge both streams by date.
  let rows = folder.src === 'queue' ? qRows
    : folder.src === 'received' ? rRows
    : [...qRows, ...rRows].sort((a, b) => (b.sortKey || '').localeCompare(a.sortKey || ''));

  const q = search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.who.toLowerCase().includes(q) || r.subject.toLowerCase().includes(q));

  if (rows.length === 0) {
    return <div className="p-8 text-center text-sm text-muted">{q ? t('messages.noSearchResults', 'No matches') : t('messages.noMessages', 'No messages')}</div>;
  }

  return (
    <ul>
      {rows.map((r) => (
        <li key={r.key}>
          <button
            onClick={r.onClick}
            className={`w-full text-left px-4 py-3 border-b border-line-faint border-l-[3px] transition-colors ${
              r.active
                ? 'border-l-accent bg-accent-soft'
                : 'border-l-transparent hover:bg-hover-soft'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[13.5px] text-heading truncate">{r.who}</span>
              <span className="ml-auto text-[11px] text-faint tabular-nums whitespace-nowrap">{r.when}</span>
            </div>
            <div className="text-[13px] text-body truncate mt-0.5">{r.subject}</div>
            <div className="flex items-center gap-2 mt-1.5">
              <Badge tone={STATUS_TONES[r.status] || 'neutral'}>
                {r.status}
              </Badge>
              {r.attach > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                  <Paperclip className="w-3 h-3" />{r.attach}
                </span>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
};

// ─────────────────────────────────────────────────────────── reading pane ──
const ReadingPane: React.FC<{
  selection: Selection;
  account: Account;
  identities?: MailIdentities | null;
  flags: Record<string, boolean>;
  folderState?: 'archived' | 'deleted';
  onViewDoc: (id: number) => void;
  onOpenAccounting: () => void;
  onCompose: (init: ComposerInit, title?: string) => void;
  onOpenDoc: (docType: DocType, senderEmail: string) => void;
  onItemAction: (action: 'archive' | 'delete' | 'restore') => void;
  canEdit: boolean;
  t: TFunction;
}> = ({ selection, account, identities, flags, folderState, onViewDoc, onOpenAccounting, onCompose, onOpenDoc, onItemAction, canEdit, t }) => {
  const detailQuery = useQuery({
    queryKey: ['messages', 'queue', selection?.kind === 'queue' ? selection.id : null],
    queryFn: () => emailService.getQueueItem((selection as { kind: 'queue'; id: number }).id),
    enabled: selection?.kind === 'queue',
  });

  if (!selection) {
    return (
      <div className="flex-1 grid place-items-center text-center text-faint p-10">
        <div>
          <Mail className="w-9 h-9 mx-auto mb-3 text-faint" />
          <div className="text-sm">{t('messages.selectPrompt', 'Select a message to read')}</div>
        </div>
      </div>
    );
  }

  // Accounting toolbar only for the rechnungen@ stream; customer mail (inbound
  // or the automated/sent streams) gets the CRM action set.
  const isAcct = selection.kind === 'received'
    ? selection.item.account_key !== 'customers'
    : account.id === 'acct';

  const recipient = extractEmail(selection.kind === 'received'
    ? selection.item.from_address
    : detailQuery.data?.recipientEmail);

  // Reply only makes sense for an inbound message with a sender.
  const onReply = selection.kind === 'received' && selection.item.from_address
    ? () => {
        const it = selection.item;
        const subj = /^re:/i.test(it.subject || '') ? (it.subject || '') : `Re: ${it.subject || ''}`;
        const quoted = `<p><br></p><p style="color:#888;font-size:12px">${t('messages.onWrote', 'On')} ${fmt(it.received_at)}, ${escapeHtml(it.from_address || '')}:</p>`;
        onCompose({ to: extractEmail(it.from_address), subject: subj, html: quoted, replyToReceivedId: it.id }, t('messages.reply', 'Reply'));
      }
    : undefined;

  // Quote/Contract/Invoice/Gallery open the document-action flow (resolve the
  // customer, then create-new or select-existing). Customer-facing streams only.
  const onDoc = !isAcct && recipient
    ? (docType: DocType) => onOpenDoc(docType, recipient)
    : undefined;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <Toolbar isAcct={isAcct} flags={flags} folderState={folderState} onReply={onReply} onDoc={onDoc} onItemAction={onItemAction} canEdit={canEdit} t={t} />
      <div className="flex-1 overflow-y-auto p-6">
        {selection.kind === 'queue' ? (
          detailQuery.isLoading ? <Loading /> : detailQuery.data ? (
            <QueueDetail d={detailQuery.data} fromAddr={identities?.automated} t={t} />
          ) : (
            <div className="text-sm text-muted">{t('messages.loadError', 'Could not load this message.')}</div>
          )
        ) : (
          <ReceivedDetail
            item={selection.item}
            mailboxAddr={selection.item.account_key === 'customers' ? identities?.customers : identities?.accounting}
            onViewDoc={onViewDoc}
            onOpenAccounting={onOpenAccounting}
            t={t}
          />
        )}
      </div>
    </div>
  );
};

const QueueDetail: React.FC<{ d: import('../../../services/email.service').EmailQueueDetail; fromAddr?: string | null; t: TFunction }> = ({ d, fromAddr, t }) => (
  <>
    <h2 className="text-xl font-semibold text-heading" style={{ textWrap: 'balance' } as React.CSSProperties}>
      {friendlyType(d.emailType)}
    </h2>
    <div className="mt-3 pb-4 border-b border-line-faint text-sm">
      <div className="text-body">
        {t('messages.from', 'from')} <span className="font-mono text-xs">{fromAddr || '—'}</span> · {t('messages.to', 'to')}{' '}
        <span className="font-semibold text-heading">{d.recipientEmail}</span>
      </div>
      {d.cc && <div className="text-muted text-xs mt-0.5">cc {d.cc}</div>}
      <div className="text-faint text-xs mt-0.5 tabular-nums">{fmt(d.sentAt || d.createdAt)}</div>
    </div>

    {d.renderedHtml ? (
      <div className="mt-4 rounded-lg border border-line-faint overflow-hidden bg-white" style={{ height: '52vh' }}>
        {/* Our own template output, but rendered with a strict script-less,
            no-same-origin sandbox anyway — matches the inbound-mail pane. */}
        <iframe title="Email body" sandbox="" srcDoc={d.renderedHtml} className="w-full h-full border-0" />
      </div>
    ) : (
      <div className="mt-4 text-sm text-muted italic">
        {t('messages.noBody', 'This message was sent before body capture was added, so no preview is available.')}
      </div>
    )}

    {d.attachments.length > 0 && (
      <div className="mt-5">
        <div className="text-[11px] font-bold uppercase tracking-wide text-faint mb-2">
          {d.attachments.length} {t('messages.attachments', 'attachment(s)')}
        </div>
        <div className="flex flex-col gap-2 max-w-md">
          {d.attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-line-faint bg-subtle">
              <FileText className="w-5 h-5 text-danger flex-none" />
              <span className="text-[13.5px] font-medium text-heading truncate">{a.filename}</span>
              <span className="ml-auto text-[11px] text-faint" title={t('messages.sentAttachHint', 'Sent attachments are not archived yet — Phase 2.')}>
                {t('messages.notArchived', 'not archived yet')}
              </span>
            </div>
          ))}
        </div>
      </div>
    )}
  </>
);

const ReceivedDetail: React.FC<{
  item: ReceivedEmail;
  mailboxAddr?: string | null;
  onViewDoc: (id: number) => void;
  onOpenAccounting: () => void;
  t: TFunction;
}> = ({ item, mailboxAddr, onViewDoc, onOpenAccounting, t }) => {
  const detail = useQuery({
    queryKey: ['messages', 'received', 'item', item.id],
    queryFn: () => emailService.getReceivedItem(item.id),
  });
  const toAddr = detail.data?.to_address || item.to_address || mailboxAddr || '—';
  return (
    <>
      <h2 className="text-xl font-semibold text-heading" style={{ textWrap: 'balance' } as React.CSSProperties}>
        {item.subject || t('messages.noSubject', '(no subject)')}
      </h2>
      <div className="mt-3 pb-4 border-b border-line-faint text-sm">
        <div className="text-body">
          {t('messages.from', 'from')} <span className="font-semibold text-heading">{item.from_address || '—'}</span>
          {' · '}{t('messages.to', 'to')} <span className="font-mono text-xs">{toAddr}</span>
        </div>
        <div className="text-faint text-xs mt-0.5 tabular-nums">{fmt(item.received_at)}</div>
      </div>

      {detail.isLoading ? (
        <div className="mt-4"><Loading /></div>
      ) : detail.data?.body_html ? (
        <div className="mt-4 rounded-lg border border-line-faint overflow-hidden bg-white" style={{ height: '48vh' }}>
          <EmailBodyFrame key={item.id} html={detail.data.body_html} />
        </div>
      ) : detail.data?.body_text ? (
        <pre className="mt-4 whitespace-pre-wrap text-sm text-body font-sans">{detail.data.body_text}</pre>
      ) : (
        <div className="mt-4 text-sm text-muted italic">
          {t('messages.noInboundBody', 'No message body was captured for this email.')}
        </div>
      )}

      {item.inbound_document_id != null && (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => onViewDoc(item.inbound_document_id as number)}
            leftIcon={<FileText className="w-4 h-4" />}
          >
            {t('messages.viewDocument', 'View document')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenAccounting}
            leftIcon={<Link2 className="w-4 h-4" />}
          >
            {t('messages.openInAccounting', 'Open in Accounting inbox')}
          </Button>
        </div>
      )}
      {item.error && (
        <div className="mt-4 text-sm text-danger-text">{item.error}</div>
      )}
    </>
  );
};

// ─────────────────────────────────────────────────────────────── toolbar ──
const Toolbar: React.FC<{
  isAcct: boolean;
  flags: Record<string, boolean>;
  folderState?: 'archived' | 'deleted';
  onReply?: () => void;
  onDoc?: (docType: DocType) => void;
  onItemAction: (action: 'archive' | 'delete' | 'restore') => void;
  canEdit: boolean;
  t: TFunction;
}> = ({ isAcct, flags, folderState, onReply, onDoc, onItemAction, canEdit, t }) => {
  const Tb: React.FC<{ icon: LucideIcon; label: string; accent?: boolean; onClick?: () => void }> = ({ icon: Icon, label, accent, onClick }) => {
    const enabled = !!onClick;
    return (
      <button
        onClick={onClick}
        disabled={!enabled}
        title={enabled ? undefined : t('messages.soon', 'Available in a later phase')}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[13px] font-medium ${
          enabled ? 'hover:bg-hover-soft ' : 'cursor-not-allowed opacity-50 '
        }${accent ? 'text-accent font-semibold' : 'text-body'}`}
      >
        <Icon className="w-[15px] h-[15px]" />{label}
      </button>
    );
  };
  const doc = (docType: DocType) => (onDoc ? () => onDoc(docType) : undefined);
  return (
    <div className="flex items-center gap-1 flex-wrap px-3 py-2 border-b border-line-faint flex-none">
      <Tb icon={Reply} label={t('messages.reply', 'Reply')} onClick={onReply} />
      <Tb icon={ReplyAll} label={t('messages.replyAll', 'Reply all')} />
      <Tb icon={Forward} label={t('messages.forward', 'Forward')} />
      <span className="w-px h-5 bg-fill mx-1" />
      {isAcct ? (
        <>
          <Tb icon={ReceiptText} label={t('messages.bookExpense', 'Book as expense')} accent />
          <Tb icon={Forward} label={t('messages.rebill', 'Re-bill to client')} accent />
        </>
      ) : (
        <>
          {flags.quotes && <Tb icon={Quote} label={t('messages.createQuote', 'Quote')} accent onClick={doc('quote')} />}
          {flags.contracts && <Tb icon={FileSignature} label={t('messages.createContract', 'Contract')} accent onClick={doc('contract')} />}
          <Tb icon={ImageIcon} label={t('messages.createGallery', 'Gallery')} accent onClick={doc('gallery')} />
          {flags.bills && <Tb icon={FileText} label={t('messages.createInvoice', 'Invoice')} accent onClick={doc('invoice')} />}
        </>
      )}
      <span className="flex-1" />
      {canEdit && folderState && <Tb icon={RotateCcw} label={t('messages.restore', 'Restore')} onClick={() => onItemAction('restore')} />}
      {canEdit && folderState !== 'archived' && <Tb icon={Archive} label={t('messages.archive', 'Archive')} onClick={() => onItemAction('archive')} />}
      {canEdit && (
        <Tb
          icon={Trash2}
          label={folderState === 'deleted' ? t('messages.deleteForever', 'Delete permanently') : t('messages.delete', 'Delete')}
          onClick={() => onItemAction('delete')}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────── pdf modal ──
const PdfModal: React.FC<{ docId: number; onClose: () => void; t: TFunction }> = ({ docId, onClose, t }) => {
  const [page, setPage] = useState(1);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setErr(false);
    setUrl(null);
    accountingService.getInboundPageBlob(docId, page)
      .then((blob) => {
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        revoked = u;
        setUrl(u);
      })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; if (revoked) URL.revokeObjectURL(revoked); };
  }, [docId, page]);

  return (
    <Modal
      open
      onClose={onClose}
      title={(
        <span className="inline-flex items-center gap-2">
          <FileText className="w-4 h-4 text-danger" aria-hidden="true" />
          {t('messages.document', 'Document')}
        </span>
      )}
      description={t('messages.rasterNote', 'Server-rendered preview — the raw file never reaches the browser.')}
      size="md"
      footer={(
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            aria-label={t('common.previous', 'Previous')}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-xs tabular-nums text-muted w-6 text-center">{page}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPage((p) => p + 1)}
            aria-label={t('common.next', 'Next')}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    >
      <div className="-mx-6 -my-4 p-5 bg-subtle grid place-items-center min-h-[240px]">
        {err ? (
          <div className="text-sm text-muted">{t('messages.previewUnavailable', 'Preview unavailable')}</div>
        ) : url ? (
          <img src={url} alt="" className="max-w-full shadow-lg rounded" />
        ) : (
          <Loading />
        )}
      </div>
    </Modal>
  );
};

export default MessagesPage;
