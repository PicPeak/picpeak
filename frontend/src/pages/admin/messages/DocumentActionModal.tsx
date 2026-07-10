import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X, Plus, FileText } from 'lucide-react';
import { Button, Loading } from '../../../components/common';
import { CustomerPicker } from '../../../components/admin/CustomerPicker';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { quotesService } from '../../../services/quotes.service';
import { contractsService } from '../../../services/contracts.service';
import { billsService } from '../../../services/bills.service';

/**
 * From a customer message: resolve (or pick/create) the customer, then either
 * create a NEW document of the given type (jumps to the real editor prefilled
 * with the customer) or SELECT an existing one to reference in a reply. Reuses
 * the CRM editors, list endpoints and CustomerPicker — no duplicated doc logic.
 */
export type DocType = 'quote' | 'contract' | 'invoice' | 'gallery';

const CONFIG: Record<DocType, { label: string; newRoute: string; hasExisting: boolean }> = {
  quote: { label: 'Quote', newRoute: '/admin/clients/quotes/new', hasExisting: true },
  contract: { label: 'Contract', newRoute: '/admin/clients/contracts/new', hasExisting: true },
  invoice: { label: 'Invoice', newRoute: '/admin/clients/bills/new', hasExisting: true },
  gallery: { label: 'Gallery', newRoute: '/admin/events/new', hasExisting: false },
};

interface DocRow { id: number; number: string; status: string }

type SelCustomer = { id: number; email: string; label: string };

export const DocumentActionModal: React.FC<{
  docType: DocType;
  senderEmail: string;
  onCompose: (init: { to: string; subject: string; html: string }) => void;
  onClose: () => void;
  t: (k: string, d?: string) => string;
}> = ({ docType, senderEmail, onCompose, onClose, t }) => {
  const navigate = useNavigate();
  const cfg = CONFIG[docType];
  const [customer, setCustomer] = useState<SelCustomer | null>(null);
  const [resolving, setResolving] = useState(true);

  const pick = (c: { id: number; email: string; displayName?: string | null; companyName?: string | null }) =>
    setCustomer({ id: c.id, email: c.email, label: c.companyName || c.displayName || c.email });

  // Resolve the customer from the message's sender address (first match).
  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    customerAdminService.search(senderEmail)
      .then((rows) => {
        if (cancelled) return;
        // search matches email/name/company PREFIXES — only auto-pick on an
        // EXACT email match so a spoofed/partial sender can't prefill the wrong
        // customer. Otherwise leave the picker for the admin to choose.
        const target = senderEmail.trim().toLowerCase();
        const exact = rows.find((r) => (r.email || '').toLowerCase() === target);
        if (exact) pick(exact);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setResolving(false); });
    return () => { cancelled = true; };
  }, [senderEmail]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const existing = useQuery({
    queryKey: ['messages', 'docs', docType, customer?.id],
    enabled: !!customer && cfg.hasExisting,
    queryFn: async (): Promise<DocRow[]> => {
      const customerAccountId = customer!.id;
      if (docType === 'quote') {
        const r = await quotesService.list({ customerAccountId, page: 1, pageSize: 20 });
        return r.quotes.map((q) => ({ id: q.id, number: q.quoteNumber, status: q.status }));
      }
      if (docType === 'contract') {
        const r = await contractsService.list({ customerAccountId, page: 1, pageSize: 20 });
        return r.contracts.map((c) => ({ id: c.id, number: c.contractNumber, status: c.status }));
      }
      const r = await billsService.list({ customerAccountId, page: 1, pageSize: 20 });
      return r.invoices.map((i) => ({ id: i.id, number: i.invoiceNumber, status: i.status }));
    },
  });

  const createNew = () => {
    if (!customer && docType !== 'gallery') return;
    navigate(docType === 'gallery' || !customer ? cfg.newRoute : `${cfg.newRoute}?customerAccountId=${customer.id}`);
    onClose();
  };

  const pickExisting = (d: DocRow) => {
    const html = `<p><br></p><p>${cfg.label} <strong>${d.number}</strong></p><p><br></p>`;
    onCompose({ to: customer?.email || senderEmail, subject: `${cfg.label} ${d.number}`, html });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-900 rounded-xl w-[min(560px,96vw)] max-h-[88vh] flex flex-col overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            {t(`messages.doc.${docType}`, cfg.label)}
          </span>
          <button onClick={onClose} className="ml-auto w-8 h-8 grid place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label={t('messages.close', 'Close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          <div>
            <div className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('messages.customer', 'Customer')}</div>
            <CustomerPicker
              value={customer?.id ?? null}
              label={customer?.label || ''}
              onSelect={pick}
              onCreate={pick}
              onClear={() => setCustomer(null)}
            />
            {resolving && <p className="mt-1 text-xs text-neutral-400">{t('messages.resolvingCustomer', 'Matching the sender to a customer…')}</p>}
            {!resolving && !customer && (
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('messages.noCustomerMatch', 'No customer matched this sender — search for one or create a new customer above.')}
              </p>
            )}
          </div>

          {customer && (
            <>
              <Button variant="primary" onClick={createNew} leftIcon={<Plus className="w-4 h-4" />} className="w-full justify-center">
                {t('messages.createNewDoc', 'Create new {{label}}', { label: t(`messages.doc.${docType}`, cfg.label) } as any)}
              </Button>

              {cfg.hasExisting && (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-neutral-400 mb-2">
                    {t('messages.existingDocs', 'Or reference an existing one')}
                  </div>
                  {existing.isLoading ? (
                    <Loading />
                  ) : (existing.data && existing.data.length > 0) ? (
                    <div className="flex flex-col gap-1.5 max-h-[38vh] overflow-y-auto">
                      {existing.data.map((d) => (
                        <button
                          key={d.id}
                          onClick={() => pickExisting(d)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 text-left"
                        >
                          <FileText className="w-4 h-4 text-neutral-400 flex-none" />
                          <span className="font-mono text-[13px] text-neutral-800 dark:text-neutral-100">{d.number}</span>
                          <span className="ml-auto text-[11px] text-neutral-400">{d.status}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('messages.noExistingDocs', 'No existing documents for this customer yet.')}</p>
                  )}
                </div>
              )}
              {!cfg.hasExisting && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t('messages.galleryCreateOnly', 'Galleries are event-based — this opens the event editor, where you can assign the customer.')}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DocumentActionModal;
