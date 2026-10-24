/**
 * Attach an existing quote, contract, gallery or invoice to the project: a search
 * window opened from the Documents card. Without a search term it lists the
 * project customer's documents (or the newest galleries); a click attaches
 * through POST /projects/:id/quotes|contracts|events|invoices,
 * which run every ownership and customer check.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { FileText, Image as ImageIcon, Receipt, ScrollText, Search } from 'lucide-react';
import { Input, Modal } from '../../../components/common';
import { eventsService } from '../../../services/events.service';
import { quotesService } from '../../../services/quotes.service';
import { contractsService } from '../../../services/contracts.service';
import { billsService } from '../../../services/bills.service';
import { projectsService, type ProjectOverview } from '../../../services/projects.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

export type AttachKind = 'quote' | 'contract' | 'gallery' | 'invoice';

interface Candidate {
  id: number;
  title: string;
  date: string | null;
  /** It, or a record of its deal, is in another project; attaching moves it here. */
  elsewhere: boolean;
  /** Another project holds it and it cannot move (an invoice). */
  locked?: boolean;
  /** Why it cannot (the API code). */
  refusal?: string;
}

interface Props {
  kind: AttachKind | null;
  data: ProjectOverview;
  onClose: () => void;
}

const ICON: Record<AttachKind, React.ReactNode> = {
  quote: <FileText className="w-4 h-4" />,
  contract: <ScrollText className="w-4 h-4" />,
  gallery: <ImageIcon className="w-4 h-4" />,
  invoice: <Receipt className="w-4 h-4" />,
};

/** Waits until typing pauses, so each key press is not a request. */
function useDebounced(value: string, ms = 250): string {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return out;
}

export const AttachDocumentDialog: React.FC<Props> = ({ kind, data, onClose }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const qc = useQueryClient();
  const projectId = data.project.id;
  const customerAccountId = data.project.customerAccountId || undefined;
  const [term, setTerm] = useState('');
  const q = useDebounced(term.trim());

  useEffect(() => { if (kind) setTerm(''); }, [kind]);

  const held = new Set<number>(
    kind === 'quote' ? data.quotes.map((x) => x.id)
      : kind === 'contract' ? data.contracts.map((x) => x.id)
        : kind === 'invoice' ? data.invoices.map((x) => x.id)
          : data.events.map((x) => x.id),
  );

  const { data: candidates = [], isFetching } = useQuery({
    queryKey: ['project-attach-search', kind, projectId, q],
    enabled: !!kind,
    queryFn: async (): Promise<Candidate[]> => {
      // A search term looks everywhere; none lists this customer's documents.
      const scope = q ? { q } : { customerAccountId };
      // Attaching a quote or contract moves its whole deal, so the server
      // says whether anything of it sits in another project (attachMoves).
      if (kind === 'quote') {
        const res = await quotesService.list({ ...scope, pageSize: 20, attachTo: projectId });
        return res.quotes.map((x) => ({
          id: x.id, title: x.quoteNumber, date: x.issueDate ?? null,
          elsewhere: x.attachMoves ?? (x.projectId != null && x.projectId !== projectId),
        }));
      }
      if (kind === 'contract') {
        const res = await contractsService.list({ ...scope, pageSize: 20, attachTo: projectId });
        return res.contracts.map((x) => ({
          id: x.id, title: x.contractNumber, date: x.issueDate ?? null,
          elsewhere: x.attachMoves ?? (x.projectId != null && x.projectId !== projectId),
        }));
      }
      if (kind === 'invoice') {
        // The server answers with the attach's own rule (attachRefusal), so
        // the window never offers what the attach refuses.
        const res = await billsService.list({ ...scope, pageSize: 20, attachTo: projectId });
        return res.invoices.filter((x) => x.kind !== 'storno').map((x) => ({
          id: x.id, title: x.invoiceNumber, date: x.issueDate ?? null,
          elsewhere: !!x.attachRefusal, locked: !!x.attachRefusal, refusal: x.attachRefusal || undefined,
        }));
      }
      const res = await eventsService.getEvents({ limit: 20, search: q || undefined, sortBy: 'created_at', sortOrder: 'desc' });
      return (res.events || []).map((ev) => ({
        id: ev.id, title: ev.event_name, date: ev.event_date ?? null,
        elsewhere: ev.project_id != null && ev.project_id !== projectId,
      }));
    },
  });

  const attach = useMutation({
    mutationFn: (id: number) => (kind === 'quote'
      ? projectsService.assignQuote(projectId, id)
      : kind === 'contract'
        ? projectsService.assignContract(projectId, id)
        : kind === 'invoice'
          ? projectsService.assignInvoice(projectId, id)
          : projectsService.assignEvent(projectId, id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('projects.attach.done', 'Added to the project') as string);
      onClose();
    },
    onError: (err: unknown) => {
      const res = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      if (res?.code === 'PROJECT_CUSTOMER_MISMATCH') {
        toast.error(t('projects.error.customerMismatch', 'That belongs to a different customer than this project.') as string);
        return;
      }
      const why = refusalText(res?.code);
      if (why) {
        toast.error(why);
        return;
      }
      toast.error(res?.error || (t('projects.attach.failed', 'Could not add it to the project') as string));
    },
  });

  // What each refusal tells the admin, so they know what to move out.
  const refusalText = (code?: string | null): string | null => {
    switch (code) {
      case 'PROJECT_INVOICE_ELSEWHERE':
        return t('projects.attach.invoiceElsewhere', 'This invoice already belongs to another project.') as string;
      case 'PROJECT_DEAL_ELSEWHERE':
        return t('projects.attach.dealElsewhere', 'Its quote, contract or another invoice of the same job belongs to another project.') as string;
      case 'PROJECT_EVENT_MISMATCH':
        return t('projects.attach.galleryElsewhere', 'Its gallery belongs to another project. Add it there, or move the gallery first.') as string;
      case 'PROJECT_INVOICE_COLLECTED_BILLING':
        return t('projects.attach.collected', 'A collected monthly invoice covers several jobs, so it cannot belong to one project.') as string;
      default:
        return null;
    }
  };

  const shown = candidates.filter((c) => !held.has(c.id));
  const title = kind === 'quote'
    ? t('projects.attach.quoteTitle', 'Add a quote')
    : kind === 'contract'
      ? t('projects.attach.contractTitle', 'Add a contract')
      : kind === 'invoice'
        ? t('projects.attach.invoiceTitle', 'Add an invoice')
        : t('projects.attach.galleryTitle', 'Add a gallery');

  return (
    <Modal
      open={!!kind}
      onClose={onClose}
      title={title}
      description={kind === 'gallery'
        ? t('projects.attach.helpGallery', 'The newest galleries. Search by name to find any other.')
        : q || !customerAccountId
          ? t('projects.attach.help', 'Search by number or name. Its linked documents come along.')
          : t('projects.attach.helpCustomer', 'This customer’s documents. Search to find any other.')}
      size="md"
    >
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        leftIcon={<Search className="w-4 h-4" />}
        placeholder={t('projects.attach.search', 'Search…') as string}
        aria-label={t('projects.attach.search', 'Search…') as string}
        autoFocus
      />
      <div className="mt-3 space-y-1.5" aria-busy={isFetching}>
        {shown.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={attach.isPending || c.locked}
            onClick={() => attach.mutate(c.id)}
            className="w-full flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left hover:bg-hover-soft disabled:opacity-60"
          >
            <span className="w-8 h-8 rounded-lg grid place-items-center bg-inset text-soft shrink-0">{kind && ICON[kind]}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-heading truncate">{c.title}</span>
              <span className="block text-xs text-muted truncate">
                {[c.date ? format(c.date) : '', c.locked ? (refusalText(c.refusal) || t('projects.attach.locked', 'in another project')) : c.elsewhere ? t('projects.attach.elsewhere', 'in another project, moves here') : '']
                  .filter(Boolean).join(' · ')}
              </span>
            </span>
          </button>
        ))}
        {!isFetching && shown.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted">{t('projects.attach.none', 'Nothing found.')}</p>
        )}
      </div>
    </Modal>
  );
};
