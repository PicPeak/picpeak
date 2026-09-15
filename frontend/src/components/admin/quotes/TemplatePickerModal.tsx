/**
 * "New quote" chooser (#1451): start blank, or pick a published template,
 * the customer and the event basics — the server creates a draft quote from
 * the template and the editor opens on it, fully editable.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Input, LocalizedDateInput } from '../../common';
import { DecimalInput } from '../../common/DecimalInput';
import { CustomerPicker } from '../CustomerPicker';
import { PermissionGate } from '../PermissionGate';
import { quoteCatalogService } from '../../../services/quoteCatalog.service';

interface Props {
  open: boolean;
  onClose: () => void;
}

export const TemplatePickerModal: React.FC<Props> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [customer, setCustomer] = useState<{ id: number | null; label: string; isPassive: boolean }>({ id: null, label: '', isPassive: false });
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [hours, setHours] = useState<number>(NaN);
  const [busy, setBusy] = useState(false);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['quote-catalog', 'templates', 'published'],
    queryFn: () => quoteCatalogService.listTemplates({ publishedOnly: true }),
    enabled: open,
  });

  if (!open) return null;

  const selected = templates.find((tpl) => tpl.id === templateId) || null;

  const create = async () => {
    if (!selected || !customer.id) return;
    setBusy(true);
    try {
      const result = await quoteCatalogService.createQuoteFromTemplate(selected.id, {
        customerAccountId: customer.id,
        eventName: eventName || undefined,
        eventDate: eventDate || undefined,
        hours: Number.isFinite(hours) ? hours : null,
      });
      if (result.skippedPromotions.length > 0) {
        toast.info(t('quotes.templates.skippedPromotions', 'Not applied (not valid today): {{names}}', {
          names: result.skippedPromotions.join(', '),
        }));
      }
      onClose();
      navigate(`/admin/clients/quotes/${result.quoteId}/edit`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true"
      aria-labelledby="template-picker-title">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 id="template-picker-title" className="text-lg font-semibold">{t('quotes.new', 'New quote')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close', 'Close') as string}
            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <label htmlFor="template-picker-template" className="block text-sm font-medium mb-1">
              {t('quotes.templates.pickLabel', 'Start from')}
            </label>
            <select
              id="template-picker-template"
              value={templateId ?? ''}
              onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
            >
              <option value="">{t('quotes.templates.blankQuote', 'Blank quote')}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
            {!isLoading && templates.length === 0 && (
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('quotes.templates.noneYet', 'No published templates yet — create one under Catalogue & templates.')}
              </p>
            )}
            {selected?.description && (
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{selected.description}</p>
            )}
          </div>

          {selected && (
            <>
              <CustomerPicker
                value={customer.id}
                label={customer.label}
                isPassive={customer.isPassive}
                onSelect={(c) => setCustomer({ id: c.id, label: c.companyName || c.displayName || c.email, isPassive: Boolean(c.isPassive) })}
                onCreate={(c) => setCustomer({ id: c.id, label: c.companyName || c.displayName || c.email, isPassive: Boolean(c.isPassive) })}
                onClear={() => setCustomer({ id: null, label: '', isPassive: false })}
                searchPlaceholder={t('quotes.customerSearch', 'Search customer by email or company…') as string}
              />
              <Input label={t('quotes.field.eventName', 'Event') as string} value={eventName}
                onChange={(e) => setEventName(e.target.value)} />
              <LocalizedDateInput label={t('quotes.field.eventDate', 'Event date') as string} value={eventDate}
                onChange={(iso) => setEventDate(iso)} />
              <div>
                <label htmlFor="template-picker-hours" className="block text-sm font-medium mb-1">{t('quotes.field.hours', 'Hours')}</label>
                <DecimalInput id="template-picker-hours" value={hours} onChange={setHours} fractionDigits={2}
                  placeholder={selected.draft.hours != null ? String(selected.draft.hours) : ''}
                  className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm" />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('quotes.templates.hoursHint', 'Leave blank to use the template\'s hours.')}
                </p>
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          {selected ? (
            <PermissionGate permission="quotes.manage">
              <Button onClick={create} disabled={busy || !customer.id}>
                {t('quotes.templates.createFromTemplate', 'Create quote')}
              </Button>
            </PermissionGate>
          ) : (
            <Button onClick={() => { onClose(); navigate('/admin/clients/quotes/new'); }}>
              {t('quotes.templates.startBlank', 'Start blank')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
