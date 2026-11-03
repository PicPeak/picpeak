/**
 * The dialogs behind customer gifts (migration 343): give a gift, decline a
 * milestone, add stock, correct stock. Shared by the Gifts page and the
 * customer record.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';

import { Button, Input, LocalizedDateInput, Modal, Notice, Switch } from '../common';
import { DecimalInput } from '../common/DecimalInput';
import { useMutationWithToast } from '../../hooks';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { accountingService, type InboundDocument } from '../../services/accounting.service';
import { giftsService, type GiftItem } from '../../services/gifts.service';
import { formatMoneyMinor } from '../../utils/money';

const today = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const useRefreshGifts = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['admin-gift-suggestions'] });
    queryClient.invalidateQueries({ queryKey: ['admin-gift-items'] });
    queryClient.invalidateQueries({ queryKey: ['admin-customer-gifts'] });
    queryClient.invalidateQueries({ queryKey: ['admin-gift-movements'] });
  };
};

const fieldLabel = 'block text-sm font-medium text-heading mb-1';

interface GiveGiftModalProps {
  open: boolean;
  onClose: () => void;
  customerId: number;
  customerName?: string;
  /** Closes this milestone. Left out, the gift is one by hand. */
  milestoneYears?: number;
  isOverride?: boolean;
}

export const GiveGiftModal: React.FC<GiveGiftModalProps> = ({
  open, onClose, customerId, customerName, milestoneYears, isOverride = false,
}) => {
  const { t } = useTranslation();
  const refresh = useRefreshGifts();
  const [itemId, setItemId] = useState<number | ''>('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [reduceStock, setReduceStock] = useState(true);

  const { data: items = [] } = useQuery({
    queryKey: ['admin-gift-items', false],
    queryFn: () => giftsService.listItems(false),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setDate(today());
    setNote('');
    setReduceStock(true);
    setItemId('');
  }, [open]);

  const selected = items.find((item) => item.id === itemId);
  const outOfStock = reduceStock && !!selected && selected.stock < 1;

  const give = useMutationWithToast({
    mutationFn: () => giftsService.giveGift(customerId, {
      giftItemId: Number(itemId),
      giftDate: date,
      note: note || undefined,
      milestoneYears: milestoneYears ?? null,
      isOverride,
      reduceStock,
    }),
    successMessage: t('gifts.give.saved', 'Gift logged'),
    onSuccess: () => { refresh(); onClose(); },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={milestoneYears
        ? t('gifts.give.titleMilestone', '{{years}}-year gift', { years: milestoneYears })
        : t('gifts.give.title', 'Add gift')}
      description={customerName}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => give.mutate()} disabled={!itemId || outOfStock || give.isPending}>
            {t('gifts.give.submit', 'Log gift')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="gift-item" className={fieldLabel}>{t('gifts.give.item', 'Item')}</label>
          <select
            id="gift-item"
            className="input w-full"
            value={itemId}
            onChange={(e) => setItemId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">{t('gifts.give.pickItem', 'Pick an item')}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {t('gifts.give.itemOption', '{{name}} ({{count}} in stock)', { name: item.name, count: item.stock })}
              </option>
            ))}
          </select>
        </div>
        <LocalizedDateInput label={t('gifts.give.date', 'Date')} value={date} onChange={setDate} />
        <div>
          <label htmlFor="gift-note" className={fieldLabel}>{t('gifts.give.note', 'Note (optional)')}</label>
          <Input id="gift-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Switch
          checked={!reduceStock}
          onChange={(next) => setReduceStock(!next)}
          label={t('gifts.give.keepStock', "Don't reduce stock")}
          description={t('gifts.give.keepStockHint', 'For a gift given before you tracked stock here.')}
        />
        {outOfStock && (
          <Notice tone="warning" size="sm">
            {t('gifts.give.outOfStock', 'This item is out of stock. Add stock on the Gifts page first.')}
          </Notice>
        )}
      </div>
    </Modal>
  );
};

interface DeclineModalProps {
  open: boolean;
  onClose: () => void;
  customerId: number;
  customerName?: string;
  milestoneYears: number;
}

export const DeclineGiftModal: React.FC<DeclineModalProps> = ({
  open, onClose, customerId, customerName, milestoneYears,
}) => {
  const { t } = useTranslation();
  const refresh = useRefreshGifts();
  const [note, setNote] = useState('');

  useEffect(() => { if (open) setNote(''); }, [open]);

  const decline = useMutationWithToast({
    mutationFn: () => giftsService.decline(customerId, { milestoneYears, note: note || undefined }),
    successMessage: t('gifts.decline.saved', 'Milestone declined'),
    onSuccess: () => { refresh(); onClose(); },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('gifts.decline.title', 'Decline {{years}}-year gift', { years: milestoneYears })}
      description={customerName}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => decline.mutate()} disabled={decline.isPending}>
            {t('gifts.decline.submit', 'Decline')}
          </Button>
        </>
      )}
    >
      <p className="text-sm text-soft mb-4">
        {t('gifts.decline.hint', 'This closes the milestone. Stock stays the same, and the next milestone still comes up.')}
      </p>
      <label htmlFor="gift-decline-note" className={fieldLabel}>{t('gifts.decline.reason', 'Reason (optional)')}</label>
      <Input id="gift-decline-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  );
};

const invoiceLabel = (doc: InboundDocument, date: string, fallback: string) => [
  doc.supplierName,
  doc.invoiceNumber,
  date,
].filter(Boolean).join(' · ') || doc.originalFilename || fallback;

interface StockModalProps {
  item: GiftItem | null;
  onClose: () => void;
}

export const AddStockModal: React.FC<StockModalProps> = ({ item, onClose }) => {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { hasPermission } = usePermissions();
  const { format } = useLocalizedDate();
  const refresh = useRefreshGifts();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [quantity, setQuantity] = useState(1);
  const [cost, setCost] = useState(0);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [invoiceId, setInvoiceId] = useState<number | ''>('');
  // Typed by hand: the suggestion from an invoice no longer replaces it.
  const [costEdited, setCostEdited] = useState(false);

  // A supplier invoice opens a document, so the field follows the document's gate.
  const canPickInvoice = !!flags.incomingInvoices && hasPermission('accounting.view');
  const canUploadInvoice = canPickInvoice && hasPermission('accounting.manage');

  const { data: invoices } = useQuery({
    queryKey: ['admin-gift-invoices'],
    queryFn: () => accountingService.listInbound({ pageSize: 100 }),
    enabled: !!item && canPickInvoice,
  });
  // The backend refuses these two: the inbox set them aside.
  const documents: InboundDocument[] = (invoices?.items || [])
    .filter((doc) => doc.status !== 'declined' && doc.status !== 'duplicate');
  const picked = documents.find((doc) => doc.id === invoiceId);

  useEffect(() => {
    if (!item) return;
    setQuantity(1);
    setCost(0);
    setDate(today());
    setNote('');
    setInvoiceId('');
    setCostEdited(false);
  }, [item]);

  // A suggestion: the invoice may cover other goods too, so it stays editable.
  const suggestCost = (doc: InboundDocument | undefined, units: number) => {
    if (costEdited) return;
    setCost(doc?.netAmountMinor && units > 0 ? Math.round(doc.netAmountMinor / units) / 100 : 0);
  };

  const applyInvoice = (doc: InboundDocument | undefined, units: number) => {
    setDate(doc?.invoiceDate ? doc.invoiceDate.slice(0, 10) : today());
    suggestCost(doc, units);
  };

  const upload = useMutationWithToast({
    mutationFn: (file: File) => accountingService.uploadInbound(file),
    successMessage: t('gifts.stock.invoiceUploaded', 'Invoice added to incoming invoices'),
    onSuccess: (doc: InboundDocument) => {
      queryClient.invalidateQueries({ queryKey: ['admin-gift-invoices'] });
      setInvoiceId(doc.id);
      applyInvoice(doc, quantity);
    },
  });

  const add = useMutationWithToast({
    mutationFn: () => giftsService.addStock((item as GiftItem).id, {
      quantity,
      unitCostMinor: cost > 0 ? Math.round(cost * 100) : null,
      currency: picked?.currency || undefined,
      occurredOn: date,
      inboundDocumentId: invoiceId || null,
      note: note || undefined,
    }),
    successMessage: t('gifts.stock.added', 'Stock added'),
    onSuccess: () => { refresh(); onClose(); },
  });

  return (
    <Modal
      open={!!item}
      onClose={onClose}
      title={t('gifts.stock.addTitle', 'Add stock')}
      description={item?.name}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => add.mutate()} disabled={quantity < 1 || add.isPending}>
            {t('gifts.stock.addSubmit', 'Add stock')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="gift-quantity" className={fieldLabel}>{t('gifts.stock.quantity', 'Quantity')}</label>
            <Input
              id="gift-quantity"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => {
                const units = Math.max(0, Math.floor(Number(e.target.value) || 0));
                setQuantity(units);
                suggestCost(picked, units);
              }}
            />
          </div>
          <div>
            <label htmlFor="gift-cost" className={fieldLabel}>{t('gifts.stock.unitCost', 'Cost per unit (optional)')}</label>
            <DecimalInput
              id="gift-cost"
              value={cost}
              onChange={(next) => { setCostEdited(true); setCost(next); }}
              fractionDigits={2}
              className="input w-full"
            />
          </div>
        </div>
        <LocalizedDateInput label={t('gifts.stock.date', 'Date')} value={date} onChange={setDate} />
        {canPickInvoice && (
          <div>
            <label htmlFor="gift-invoice" className={fieldLabel}>{t('gifts.stock.invoice', 'Supplier invoice (optional)')}</label>
            <div className="flex flex-wrap gap-2">
              <select
                id="gift-invoice"
                className="input flex-1 min-w-0"
                value={invoiceId}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : '';
                  setInvoiceId(id);
                  applyInvoice(documents.find((doc) => doc.id === id), quantity);
                }}
              >
                <option value="">{t('gifts.stock.noInvoice', 'No invoice')}</option>
                {documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {invoiceLabel(
                      doc,
                      doc.invoiceDate ? format(doc.invoiceDate) : '',
                      t('gifts.stock.unnamedInvoice', 'Invoice #{{id}}', { id: doc.id }),
                    )}
                  </option>
                ))}
              </select>
              {canUploadInvoice && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/pdf,image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) upload.mutate(file);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    variant="outline"
                    leftIcon={<Upload className="w-4 h-4" />}
                    onClick={() => fileInput.current?.click()}
                    disabled={upload.isPending}
                  >
                    {t('gifts.stock.uploadInvoice', 'Upload')}
                  </Button>
                </>
              )}
            </div>
            {picked?.netAmountMinor ? (
              <p className="text-xs text-soft mt-1">
                {t('gifts.stock.invoiceHint', 'Net total {{amount}}. Cost per unit is a suggestion, because one invoice can cover other goods.', {
                  amount: formatMoneyMinor(picked.netAmountMinor, picked.currency || 'CHF'),
                })}
              </p>
            ) : null}
          </div>
        )}
        <div>
          <label htmlFor="gift-stock-note" className={fieldLabel}>{t('gifts.stock.note', 'Note (optional)')}</label>
          <Input id="gift-stock-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
};

export const CorrectStockModal: React.FC<StockModalProps> = ({ item, onClose }) => {
  const { t } = useTranslation();
  const refresh = useRefreshGifts();
  // Text, so a leading minus can be typed.
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!item) return;
    setDelta('');
    setReason('');
  }, [item]);

  const quantityDelta = /^[+-]?\d+$/.test(delta.trim()) ? Number(delta) : 0;

  const correct = useMutationWithToast({
    mutationFn: () => giftsService.correctStock((item as GiftItem).id, { quantityDelta, reason }),
    successMessage: t('gifts.stock.corrected', 'Stock corrected'),
    onSuccess: () => { refresh(); onClose(); },
  });

  return (
    <Modal
      open={!!item}
      onClose={onClose}
      size="sm"
      title={t('gifts.stock.correctTitle', 'Correct stock')}
      description={item?.name}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => correct.mutate()} disabled={!quantityDelta || !reason.trim() || correct.isPending}>
            {t('gifts.stock.correctSubmit', 'Save correction')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="gift-delta" className={fieldLabel}>{t('gifts.stock.delta', 'Change (for example -2)')}</label>
          <Input id="gift-delta" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} />
        </div>
        <div>
          <label htmlFor="gift-reason" className={fieldLabel}>{t('gifts.stock.reason', 'Reason')}</label>
          <Input id="gift-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
};
