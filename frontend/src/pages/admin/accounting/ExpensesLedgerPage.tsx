/**
 * Accounting → Expenses (internal own costs).
 *
 * Mileage (km) / per-diem (days) / plain amount, booked to an event or the
 * company, with an optional proof file (required when the accounting setting
 * says so). Rates default from the Accounting settings tab, overridable per
 * entry. No supplier payment here — that lives on incoming invoices.
 */
import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { X, Plus, Paperclip, Car, CalendarDays, Coins, Pencil, FileText, CheckCircle2, Circle, Lock } from 'lucide-react';
import { Button, Card, CardContent, Input, LocalizedDateInput, Loading } from '../../../components/common';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { EventBookingSelect } from '../../../components/admin/EventBookingSelect';
import { CustomerAccountPicker, type SelectedCustomer } from '../../../components/admin/CustomerAccountPicker';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useMutationWithToast, useModal } from '../../../hooks';
import {
  accountingService, categoryLabel,
  type Expense, type ExpenseKind, type ExpenseCategory, type MarkupType, type PaymentMethod,
} from '../../../services/accounting.service';

const PAYMENT_METHODS: PaymentMethod[] = ['bank_transfer', 'cash', 'twint', 'paypal', 'card', 'other'];

const KINDS: ExpenseKind[] = ['amount', 'mileage', 'per_diem'];
const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';
const kindIcon: Record<ExpenseKind, React.ReactNode> = {
  amount: <Coins className="w-3.5 h-3.5" />, mileage: <Car className="w-3.5 h-3.5" />, per_diem: <CalendarDays className="w-3.5 h-3.5" />,
};

const ExpenseFormModal: React.FC<{ categories: ExpenseCategory[]; expense?: Expense; onClose: () => void; onDone: () => void }> = ({ categories, expense, onClose, onDone }) => {
  const { t } = useTranslation();
  const isEdit = !!expense;
  const { data: settings } = useQuery({ queryKey: ['accounting-settings'], queryFn: () => accountingService.getSettings() });
  const [kind, setKind] = useState<ExpenseKind>(expense?.kind ?? 'amount');
  const [supplier, setSupplier] = useState(expense?.supplierName ?? '');
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amountMajor, setAmountMajor] = useState<number>(expense && expense.kind === 'amount' && expense.chfAmountMinor != null ? expense.chfAmountMinor / 100 : NaN);
  const [quantity, setQuantity] = useState<number>(expense?.quantity != null ? expense.quantity : NaN);
  const [rateMajor, setRateMajor] = useState<number>(expense?.rateMinor != null ? expense.rateMinor / 100 : NaN); // per-entry override (major units)
  const [categoryId, setCategoryId] = useState<number | undefined>(expense?.categoryId ?? undefined);
  const [eventId, setEventId] = useState<number | null>(expense?.eventId ?? null);
  const [file, setFile] = useState<File | null>(null);

  const defaultRateMinor = kind === 'mileage' ? (settings?.accounting_km_rate_minor ?? 0)
    : kind === 'per_diem' ? (settings?.accounting_per_diem_rate_minor ?? 0) : 0;
  const effRateMinor = Number.isFinite(rateMajor) ? Math.round(rateMajor * 100) : defaultRateMinor;
  const computedMinor = useMemo(() => {
    if (kind === 'amount') return Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : null;
    return Number.isFinite(quantity) ? Math.round(quantity * effRateMinor) : null;
  }, [kind, amountMajor, quantity, effRateMinor]);
  // Proof is only mandatory on CREATE (or when editing a row that has no
  // proof yet) — an edit on a row that already has a proof keeps it.
  const requireProof = !!settings?.accounting_require_proof && !(isEdit && expense!.hasProof);

  const payload = () => ({
    kind,
    quantity: kind === 'amount' ? undefined : (Number.isFinite(quantity) ? quantity : undefined),
    rateMinor: kind === 'amount' ? undefined : (Number.isFinite(rateMajor) ? Math.round(rateMajor * 100) : undefined),
    chfAmountMinor: kind === 'amount' && Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : undefined,
    eventId,
    categoryId: categoryId ?? null,
    supplierName: supplier || null,
    description: description || null,
  });

  const save = useMutationWithToast({
    mutationFn: () => isEdit
      ? accountingService.updateExpense(expense!.id, payload(), file)
      : accountingService.createExpense(payload(), file),
    successMessage: isEdit ? t('accounting.ledger.updatedToast', 'Expense updated.') : t('accounting.ledger.createdToast', 'Expense added.'),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
    onSuccess: () => onDone(),
  });

  const qtyLabel = kind === 'mileage' ? t('accounting.expense.km', 'Kilometres') : t('accounting.expense.days', 'Days');
  const incomplete = (kind === 'amount' && !Number.isFinite(amountMajor)) || (kind !== 'amount' && !Number.isFinite(quantity)) || (requireProof && !file);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-12 w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{isEdit ? t('accounting.ledger.editTitle', 'Edit expense') : t('accounting.ledger.addTitle', 'Add expense')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div><label className={labelCls}>{t('accounting.expense.kind', 'Type')}</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as ExpenseKind)} className={selectCls}>
              {KINDS.map((k) => <option key={k} value={k}>{t(`accounting.expenseKind.${k}`, k)}</option>)}
            </select>
          </div>

          {kind === 'amount' ? (
            <div><label className={labelCls}>{t('accounting.inbox.field.total', 'Total')}</label><DecimalInput value={amountMajor} onChange={setAmountMajor} fractionDigits={2} className={selectCls} /></div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>{qtyLabel}</label><DecimalInput value={quantity} onChange={setQuantity} fractionDigits={2} className={selectCls} /></div>
              <div><label className={labelCls}>{t('accounting.expense.rate', 'Rate')}</label>
                <DecimalInput value={rateMajor} onChange={setRateMajor} fractionDigits={2} className={selectCls} placeholder={(defaultRateMinor / 100).toFixed(2)} />
                <p className="mt-1 text-xs text-neutral-500">{t('accounting.expense.rateDefault', 'Default {{rate}} — leave blank to use it', { rate: (defaultRateMinor / 100).toFixed(2) })}</p>
              </div>
            </div>
          )}

          {computedMinor != null && <p className="text-sm text-neutral-700 dark:text-neutral-300">{t('accounting.expense.computed', 'Amount')}: <span className="font-semibold">{formatMoneyMinor(computedMinor, 'CHF')}</span></p>}

          <div><label className={labelCls}>{t('accounting.expense.who', 'Paid by / vendor')}</label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={t('accounting.expense.whoHint', 'e.g. coworker name or shop')} /></div>
          <div><label className={labelCls}>{t('accounting.ledger.description', 'Description')}</label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>

          <div><label className={labelCls}>{t('accounting.inbox.field.category', 'Category')}</label>
            <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)} className={selectCls}>
              <option value="">{t('accounting.inbox.field.categoryNone', '— none —')}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c, t)}</option>)}
            </select>
          </div>

          <div><label className={labelCls}>{t('accounting.booking.label', 'Book to')}</label>
            <EventBookingSelect value={eventId} onChange={setEventId} className={selectCls} />
          </div>

          <div>
            <label className={labelCls}>{t('accounting.expense.proof', 'Proof')}{requireProof ? ' *' : ''}</label>
            {isEdit && expense!.hasProof && !file && <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">{t('accounting.expense.proofExisting', 'A proof file is already attached — upload a new one to replace it.')}</p>}
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-sm" />
            {requireProof && !file && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('accounting.expense.proofRequired', 'A proof file is required.')}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || incomplete}>{save.isPending ? t('common.saving', 'Saving…') : (isEdit ? t('common.save', 'Save') : t('accounting.ledger.addExpense', 'Add expense'))}</Button>
        </div>
      </div>
    </div>
  );
};

/** Mark an expense supplier-paid / settled (manual). #2. */
const ExpensePaidModal: React.FC<{ expense: Expense; onClose: () => void; onDone: () => void }> = ({ expense, onClose, onDone }) => {
  const { t } = useTranslation();
  const [paidAt, setPaidAt] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const save = useMutationWithToast({
    mutationFn: () => accountingService.markExpensePaid(expense.id, { paid: true, paidAt: paidAt || undefined, paymentMethod: method, paymentReference: reference || undefined }),
    successMessage: t('accounting.ledger.paidToast', 'Marked as paid.'),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
    onSuccess: () => onDone(),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="mt-16 w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.ledger.payTitle', 'Mark expense paid')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('accounting.expense.computed', 'Amount')}: <span className="font-semibold text-neutral-900 dark:text-neutral-100">{expense.chfAmountMinor != null ? formatMoneyMinor(expense.chfAmountMinor, 'CHF') : '—'}</span>
          </p>
          <div><label className={labelCls}>{t('accounting.ledger.paidDate', 'Payment date')}</label><LocalizedDateInput value={paidAt} onChange={setPaidAt} /></div>
          <div><label className={labelCls}>{t('accounting.ledger.method', 'Method')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={selectCls}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`accounting.paymentMethod.${m}`, m)}</option>)}
            </select>
          </div>
          <div><label className={labelCls}>{t('accounting.ledger.reference', 'Reference (optional)')}</label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? t('common.saving', 'Saving…') : t('accounting.ledger.confirmPaid', 'Mark paid')}</Button>
        </div>
      </div>
    </div>
  );
};

/** Add an expense onto a client invoice (re-bill). Locks editing. #3. */
const InvoiceExpenseModal: React.FC<{ expense: Expense; onClose: () => void; onDone: () => void }> = ({ expense, onClose, onDone }) => {
  const { t } = useTranslation();
  const [customer, setCustomer] = useState<SelectedCustomer[]>([]);
  const [markupType, setMarkupType] = useState<MarkupType>('none');
  const [markupValue, setMarkupValue] = useState<number>(NaN);
  const save = useMutationWithToast({
    mutationFn: () => accountingService.invoiceExpense(expense.id, {
      customerAccountId: customer[0]!.id,
      markupType,
      markupPercent: markupType === 'percent' && Number.isFinite(markupValue) ? markupValue : null,
      markupFlatMinor: markupType === 'flat' && Number.isFinite(markupValue) ? Math.round(markupValue * 100) : null,
    }),
    successMessage: t('accounting.ledger.invoicedToast', 'Added to a client invoice.'),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
    onSuccess: () => onDone(),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-16 w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('accounting.ledger.invoiceTitle', 'Add to client invoice')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('accounting.expense.computed', 'Amount')}: <span className="font-semibold text-neutral-900 dark:text-neutral-100">{expense.chfAmountMinor != null ? formatMoneyMinor(expense.chfAmountMinor, 'CHF') : '—'}</span>
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('accounting.ledger.invoiceHint', 'This creates a billable line on the client’s next scheduled invoice and locks the expense from further edits.')}</p>
          <div><label className={labelCls}>{t('accounting.inbox.field.customer', 'Client')} *</label>
            <CustomerAccountPicker value={customer.slice(0, 1)} onChange={(next) => setCustomer(next.slice(-1))} />
          </div>
          <div><label className={labelCls}>{t('accounting.inbox.field.markup', 'Markup')}</label>
            <select value={markupType} onChange={(e) => setMarkupType(e.target.value as MarkupType)} className={selectCls}>
              <option value="none">{t('accounting.markup.none', 'None / from contract')}</option>
              <option value="percent">{t('accounting.markup.percent', 'Percent')}</option>
              <option value="flat">{t('accounting.markup.flat', 'Flat')}</option>
            </select>
          </div>
          {markupType !== 'none' && <DecimalInput value={markupValue} onChange={setMarkupValue} fractionDigits={2} className={selectCls} placeholder={markupType === 'percent' ? '%' : 'CHF'} />}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !customer[0]}>{save.isPending ? t('common.saving', 'Saving…') : t('accounting.ledger.addToInvoice', 'Add to invoice')}</Button>
        </div>
      </div>
    </div>
  );
};

export const ExpensesLedgerPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { format } = useLocalizedDate();
  const [kind, setKind] = useState('');
  const addModal = useModal();
  const [editExpense, setEditExpense] = useState<Expense | null>(null);
  const [paidExpense, setPaidExpense] = useState<Expense | null>(null);
  const [invoiceExpense, setInvoiceExpense] = useState<Expense | null>(null);

  const unpay = useMutationWithToast({
    mutationFn: (id: number) => accountingService.markExpensePaid(id, { paid: false }),
    invalidateKeys: [['accounting-expenses']],
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['accounting-expenses', kind],
    queryFn: () => accountingService.listExpenses({ kind: (kind || undefined) as ExpenseKind | undefined, pageSize: 100 }),
  });
  const { data: categories } = useQuery({ queryKey: ['expense-categories'], queryFn: () => accountingService.listCategories() });
  const catById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);

  const openProof = async (id: number) => {
    try { const blob = await accountingService.getExpenseProofBlob(id); window.open(URL.createObjectURL(blob), '_blank'); }
    catch (e: any) { toast.error(e?.response?.data?.error || e.message || 'Failed'); }
  };

  const items = data?.items ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-3">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectCls} style={{ maxWidth: 200 }}>
          <option value="">{t('accounting.ledger.allKinds', 'All types')}</option>
          {KINDS.map((k) => <option key={k} value={k}>{t(`accounting.expenseKind.${k}`, k)}</option>)}
        </select>
        <Button className="ml-auto" onClick={() => addModal.open()}><Plus className="w-4 h-4 mr-1" /> {t('accounting.ledger.addExpense', 'Add expense')}</Button>
      </div>

      {isLoading ? <Loading /> : items.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-neutral-600 dark:text-neutral-400">{t('accounting.ledger.empty', 'No expenses yet — add one above.')}</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {items.map((ex: Expense) => {
            const cat = ex.categoryId ? catById.get(ex.categoryId) : null;
            return (
              <div key={ex.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-3">
                <span className="inline-flex items-center gap-1 rounded bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">{kindIcon[ex.kind]} {t(`accounting.expenseKind.${ex.kind}`, ex.kind)}</span>
                <div className="flex-1 min-w-[10rem]">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{ex.description || ex.supplierName || t('accounting.ledger.untitled', 'Expense')}</span>
                    {/* invoiced = on a real client invoice → locked (#2/#3). */}
                    {ex.invoiced && (
                      ex.billedInvoiceId ? (
                        <Link to={`/admin/bills/${ex.billedInvoiceId}`} className="inline-flex items-center gap-1 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider hover:underline">
                          <FileText className="w-3 h-3" /> {t('accounting.ledger.invoiced', 'Invoiced')}
                        </Link>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"><FileText className="w-3 h-3" /> {t('accounting.ledger.invoiced', 'Invoiced')}</span>
                      )
                    )}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {ex.eventId != null ? `${t('accounting.booking.event', 'Event')} #${ex.eventId}` : t('accounting.booking.company', 'Company')}
                    {cat && <>{' · '}{categoryLabel(cat, t)}</>}
                    {' · '}{format(ex.createdAt)}
                  </div>
                </div>
                {ex.hasProof && <button onClick={() => openProof(ex.id)} className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline"><Paperclip className="w-3.5 h-3.5" /> {t('accounting.expense.viewProof', 'Proof')}</button>}

                {/* Paid toggle (#2): manual, independent of invoiced. */}
                {ex.paid
                  ? <button onClick={() => unpay.mutate(ex.id)} disabled={unpay.isPending} title={ex.paidAt ? format(ex.paidAt) : undefined} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30"><CheckCircle2 className="w-4 h-4" /> {t('accounting.ledger.paid', 'Paid')}</button>
                  : <Button size="sm" variant="outline" onClick={() => setPaidExpense(ex)}><Circle className="w-3.5 h-3.5 mr-1" /> {t('accounting.ledger.markPaid', 'Mark paid')}</Button>}

                {/* Edit + add-to-invoice only until invoiced (#3). */}
                {ex.invoiced ? (
                  <span className="inline-flex items-center gap-1 text-xs text-neutral-400 dark:text-neutral-500" title={t('accounting.ledger.lockedHint', 'Locked — this expense is on a client invoice.') as string}><Lock className="w-3.5 h-3.5" /> {t('accounting.ledger.locked', 'Locked')}</span>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditExpense(ex)}><Pencil className="w-3.5 h-3.5 mr-1" /> {t('common.edit', 'Edit')}</Button>
                    <Button size="sm" variant="outline" onClick={() => setInvoiceExpense(ex)}><FileText className="w-3.5 h-3.5 mr-1" /> {t('accounting.ledger.addToInvoice', 'Add to invoice')}</Button>
                  </>
                )}

                <div className="text-sm font-medium tabular-nums text-neutral-900 dark:text-neutral-100">{ex.chfAmountMinor != null ? formatMoneyMinor(ex.chfAmountMinor, 'CHF') : '—'}</div>
              </div>
            );
          })}
        </div>
      )}

      {addModal.isOpen && <ExpenseFormModal categories={categories ?? []} onClose={() => addModal.close()} onDone={() => { addModal.close(); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); }} />}
      {editExpense && <ExpenseFormModal categories={categories ?? []} expense={editExpense} onClose={() => setEditExpense(null)} onDone={() => { setEditExpense(null); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); }} />}
      {paidExpense && <ExpensePaidModal expense={paidExpense} onClose={() => setPaidExpense(null)} onDone={() => { setPaidExpense(null); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); }} />}
      {invoiceExpense && <InvoiceExpenseModal expense={invoiceExpense} onClose={() => setInvoiceExpense(null)} onDone={() => { setInvoiceExpense(null); qc.invalidateQueries({ queryKey: ['accounting-expenses'] }); }} />}
    </div>
  );
};

export default ExpensesLedgerPage;
