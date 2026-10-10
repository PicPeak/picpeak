import React, { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, FileText } from 'lucide-react';
import { Button, Loading, Modal } from '../../../components/common';
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

type SelCustomer = { id: number; email: string; label: string; isPassive: boolean };

export const DocumentActionModal: React.FC<{
  docType: DocType;
  senderEmail: string;
  onCompose: (init: { to: string; subject: string; html: string }) => void;
  onClose: () => void;
  t: TFunction;
}> = ({ docType, senderEmail, onCompose, onClose, t }) => {
  const navigate = useNavigate();
  const cfg = CONFIG[docType];
  const [customer, setCustomer] = useState<SelCustomer | null>(null);
  const [resolving, setResolving] = useState(true);

  const pick = (c: { id: number; email: string; displayName?: string | null; companyName?: string | null; isPassive?: boolean }) =>
    setCustomer({ id: c.id, email: c.email, label: c.companyName || c.displayName || c.email, isPassive: Boolean(c.isPassive) });

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
    <Modal open onClose={onClose} title={t(`messages.doc.${docType}`, cfg.label)} size="md">
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-sm font-medium text-body mb-1">{t('messages.customer', 'Customer')}</div>
            <CustomerPicker
              value={customer?.id ?? null}
              label={customer?.label || ''}
              isPassive={customer?.isPassive ?? false}
              onSelect={pick}
              onCreate={pick}
              onClear={() => setCustomer(null)}
            />
            {resolving && <p className="mt-1 text-xs text-faint">{t('messages.resolvingCustomer', 'Matching the sender to a customer…')}</p>}
            {!resolving && !customer && (
              <p className="mt-1 text-xs text-muted">
                {t('messages.noCustomerMatch', 'No customer matched this sender — search for one or create a new customer above.')}
              </p>
            )}
          </div>

          {customer && (
            <>
              <Button variant="primary" onClick={createNew} leftIcon={<Plus className="w-4 h-4" />} className="w-full justify-center">
                {t('messages.createNewDoc', 'Create new {{label}}', { label: t(`messages.doc.${docType}`, cfg.label) })}
              </Button>

              {cfg.hasExisting && (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-faint mb-2">
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
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-line-faint hover:bg-hover-soft text-left"
                        >
                          <FileText className="w-4 h-4 text-faint flex-none" />
                          <span className="font-mono text-[13px] text-heading">{d.number}</span>
                          <span className="ml-auto text-[11px] text-faint">{d.status}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted">{t('messages.noExistingDocs', 'No existing documents for this customer yet.')}</p>
                  )}
                </div>
              )}
              {!cfg.hasExisting && (
                <p className="text-xs text-muted">
                  {t('messages.galleryCreateOnly', 'This opens the gallery editor, where you can assign the customer.')}
                </p>
              )}
            </>
          )}
        </div>
    </Modal>
  );
};

export default DocumentActionModal;
