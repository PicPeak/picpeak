/**
 * <EditInstallmentPlanModal> — atomic reshape of an installment plan
 * after siblings have spawned. Wraps the same `<InstallmentsPanel>`
 * used by Quote/Bill editors, pre-filled from the existing siblings
 * (via the lineage payload — no extra fetch needed).
 *
 * Triggered from `<DocumentLineageCard>`, which only renders the
 * "Edit plan" button when every invoice on the deal is still
 * scheduled / pending_delivery (the same gate enforced server-side).
 * The server still re-checks on save; a 409 INVOICE_LOCKED races back
 * if a sibling shipped between modal open and save click.
 *
 * Plan total preservation: the backend uses sum(existing sibling totals)
 * as the plan total, so the panel doesn't need to surface money — only
 * the structure (percents / labels / triggers / offsets).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { X, AlertTriangle } from 'lucide-react';
import { Button, Card } from '../common';
import { InstallmentsPanel } from './InstallmentsPanel';
import type { PaymentTermInstallment } from '../../services/quotes.service';
import { dealsService } from '../../services/deals.service';

export interface EditInstallmentPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  dealUuid: string;
  /** Existing sibling invoices on the deal — used to seed the panel
   *  and to derive the current plan total for percent computation. */
  siblings: Array<{
    id: number;
    number: string;
    status: string;
    totalAmountMinor?: number;
    installmentIndex?: number;
    installmentTotal?: number;
    installmentLabel?: string | null;
    installmentTrigger?: string | null;
    installmentOffsetDays?: number;
  }>;
  /** Event date — passed to <InstallmentsPanel> so its date preview
   *  works for before_event / after_event rows. */
  eventDate?: string | null;
  onSaved?: () => void;
}

const VALID_TRIGGERS: PaymentTermInstallment['trigger'][] = [
  'quote_accepted', 'before_event', 'after_event', 'after_delivery', 'fixed_date',
];

function isValidTrigger(t: unknown): t is PaymentTermInstallment['trigger'] {
  return typeof t === 'string' && (VALID_TRIGGERS as string[]).includes(t);
}

export const EditInstallmentPlanModal: React.FC<EditInstallmentPlanModalProps> = ({
  isOpen, onClose, dealUuid, siblings, eventDate, onSaved,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Derive the initial panel rows from the existing siblings, sorted
  // by installment_index. Percent = total_amount_minor / sum * 100.
  const initialPlan = useMemo<PaymentTermInstallment[]>(() => {
    const sorted = [...siblings].sort(
      (a, b) => (a.installmentIndex ?? 0) - (b.installmentIndex ?? 0),
    );
    const sum = sorted.reduce((s, x) => s + (x.totalAmountMinor || 0), 0);
    if (sum === 0) {
      // Degenerate: every sibling totals zero. Fall back to equal split.
      return sorted.map((s, i) => ({
        label: s.installmentLabel || `${i + 1}/${sorted.length}`,
        percent: Math.round(10000 / sorted.length) / 100,
        trigger: isValidTrigger(s.installmentTrigger) ? s.installmentTrigger : 'fixed_date',
        offset_days: s.installmentOffsetDays ?? 0,
      }));
    }
    // Compute percents, last slice absorbs rounding so the panel reports
    // sum=100 on open.
    const rows: PaymentTermInstallment[] = [];
    let accPct = 0;
    sorted.forEach((s, i) => {
      let pct = i === sorted.length - 1
        ? Math.max(0, 100 - accPct)
        : Math.round(((s.totalAmountMinor || 0) / sum) * 10000) / 100;
      pct = Math.round(pct * 100) / 100;
      accPct += pct;
      rows.push({
        label: s.installmentLabel || `${i + 1}/${sorted.length}`,
        percent: pct,
        trigger: isValidTrigger(s.installmentTrigger) ? s.installmentTrigger : 'fixed_date',
        offset_days: s.installmentOffsetDays ?? 0,
      });
    });
    return rows;
  }, [siblings]);

  const [plan, setPlan] = useState<PaymentTermInstallment[] | null>(initialPlan);
  const [valid, setValid] = useState(true);

  // Reseed when the modal opens against fresh siblings.
  useEffect(() => {
    if (isOpen) setPlan(initialPlan);
  }, [isOpen, initialPlan]);

  const save = useMutation({
    mutationFn: async () => {
      if (!plan || plan.length === 0) {
        throw new Error(t('dealLineage.editPlanEmpty', 'Plan cannot be empty.') as string);
      }
      return dealsService.updateInstallmentPlan(dealUuid, plan);
    },
    onSuccess: () => {
      toast.success(t('dealLineage.editPlanSuccess', 'Installment plan updated.'));
      queryClient.invalidateQueries({ queryKey: ['deal-lineage', dealUuid] });
      queryClient.invalidateQueries({ queryKey: ['adminBills'] });
      queryClient.invalidateQueries({ queryKey: ['admin-invoices'] });
      onSaved?.();
      onClose();
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string; code?: string } }; message?: string };
      const code = e?.response?.data?.code;
      if (code === 'INVOICE_LOCKED' || code === 'PLAN_HAS_STORNO') {
        toast.error(t('dealLineage.editPlanLocked',
          'Plan can no longer be edited — at least one invoice has shipped or been cancelled.'));
        queryClient.invalidateQueries({ queryKey: ['deal-lineage', dealUuid] });
        onClose();
        return;
      }
      if (code === 'PERCENT_SUM_INVALID') {
        toast.error(t('dealLineage.editPlanPercentSumError', 'Percents must sum to 100.'));
        return;
      }
      toast.error(
        e?.response?.data?.error
        || e?.message
        || t('dealLineage.editPlanGeneralError', 'Could not update plan.'),
      );
    },
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold">
              {t('dealLineage.editPlanModalTitle', 'Edit installment plan')}
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('dealLineage.editPlanHelp',
                'Atomically reshape this plan: change percents, labels, triggers, add or remove rows. The plan total stays fixed; existing invoice numbers are kept where possible. Refused once any invoice has shipped.')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={save.isPending}
            className="text-neutral-400 hover:text-neutral-600 disabled:opacity-50"
            aria-label={t('common.close', 'Close') as string}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {t('dealLineage.editPlanWarning',
              'Trimming rows deletes their invoice numbers (the sequence cannot release them — a §14 UStG continuity rule). Adding rows claims fresh numbers.')}
          </p>
        </div>

        <InstallmentsPanel
          value={plan}
          onChange={(next) => setPlan(next || [])}
          onValidityChange={setValid}
          eventDate={eventDate || null}
        />

        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={save.isPending}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            isLoading={save.isPending}
            disabled={save.isPending || !valid || !plan || plan.length === 0}
          >
            {t('dealLineage.editPlanSave', 'Save plan')}
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default EditInstallmentPlanModal;
