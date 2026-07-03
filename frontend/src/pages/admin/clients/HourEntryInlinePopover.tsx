/**
 * HourEntryInlinePopover — quick-edit / delete for an hour entry,
 * opened by clicking a green chip on the admin calendar.
 *
 * Two render modes:
 *   - editable (item.locked === false): start/end/description fields
 *     + Save + Delete buttons. Save → PUT /admin/customers/:id/
 *     hour-entries/:entryId. Delete → DELETE same.
 *   - locked   (item.locked === true): read-only summary + a lock
 *     badge + tooltip "Billed — invoice X locked. Storno to edit."
 *
 * Lock predicate is computed by the backend (customerHoursService.
 * _internal.isEntryLocked) and surfaced on each item via E.3. The
 * popover trusts that flag for the UI gate; the backend STILL enforces
 * the rule on every mutation (PUT/DELETE return 409 ENTRY_LOCKED when
 * the row's invoice has shipped), so even if a stale flag slipped
 * through, the user-visible state stays correct.
 *
 * Why a portal-style fixed overlay rather than a positioned bubble:
 * FullCalendar doesn't ship a popover anchor, and the admin calendar
 * already uses a similar full-screen overlay for the drag-create
 * modal. Reusing the pattern keeps the visual language consistent.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input, TimeField } from '../../../components/common';
import { customerAdminService } from '../../../services/customerAdmin.service';
import type { CalendarHoursItem } from '../../../services/calendar.service';

export interface HourEntryInlinePopoverProps {
  item: CalendarHoursItem;
  onClose: () => void;
  /** Called after a successful mutate so the parent can invalidate queries. */
  onMutated: () => void;
}

export const HourEntryInlinePopover: React.FC<HourEntryInlinePopoverProps> = ({
  item,
  onClose,
  onMutated,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Pre-fill from the item. The form stays uncontrolled-ish — local
  // state holds the working copy, only sent on Save.
  const [startTime, setStartTime] = useState(item.startTime);
  const [endTime, setEndTime] = useState(item.endTime);
  const [description, setDescription] = useState(item.description || '');

  // F.7 — refetch before the modal closes so the calendar shows the
  // updated entry immediately (avoids the brief "block disappears"
  // gap reported on drag-create). Returns the promise so onSuccess
  // can await it.
  const refetchAll = () => Promise.all([
    queryClient.refetchQueries({ queryKey: ['calendar-items'] }),
    queryClient.refetchQueries({
      queryKey: ['admin-customer-hour-entries', item.customerAccountId],
    }),
  ]);

  const updateMutation = useMutation({
    mutationFn: () => customerAdminService.updateHourEntry(
      item.customerAccountId,
      item.id,
      {
        startTime,
        endTime,
        description: description.trim() || null,
      },
    ),
    onSuccess: async () => {
      toast.success(t('calendar.hourEntry.saved', 'Hours updated.'));
      await refetchAll();
      onMutated();
    },
    onError: (err: unknown) => {
      // I.2 — friendly toast on FEATURE_OFF; backend would have
      // 409'd if the customer's flag flipped since this entry was
      // created.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      const code = e?.response?.data?.code;
      const serverMsg = e?.response?.data?.error;
      if (code === 'FEATURE_OFF') {
        toast.error(t('calendar.hourEntry.featureOffToast',
          'Hour logging is disabled for this customer. Enable it on the customer detail page first.') as string);
        return;
      }
      const msg = serverMsg || (err instanceof Error ? err.message : String(err));
      toast.error(t('calendar.hourEntry.saveFailed', { message: msg, defaultValue: `Couldn't save: ${msg}` }) as string);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => customerAdminService.deleteHourEntry(item.customerAccountId, item.id),
    onSuccess: async () => {
      toast.success(t('calendar.hourEntry.deleted', 'Hours deleted.'));
      await refetchAll();
      onMutated();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('calendar.hourEntry.deleteFailed', { message: msg, defaultValue: `Couldn't delete: ${msg}` }) as string);
    },
  });

  const busy = updateMutation.isPending || deleteMutation.isPending;

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (item.locked || busy) return;
    updateMutation.mutate();
  };

  // I.6 — document-level Escape listener (same reasoning as the
  // drag-create modal: focus is usually on FC's canvas when this
  // popover opens, so the onKeyDown handler on the outer div never
  // sees the keydown).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card padding="lg" className="w-full max-w-md">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h2 className="font-semibold text-lg">
              {item.customerName || t('calendar.hourEntry.untitledCustomer', 'Hours')}
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {item.entryDate} · {item.startTime}–{item.endTime}
            </p>
          </div>
          {item.locked && (
            <span
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded
                         bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200"
              title={t('calendar.hourEntry.lockedTooltip',
                'Already billed — Storno the invoice to edit.') as string}
            >
              <Lock className="w-3 h-3" aria-hidden />
              {t('calendar.hourEntry.lockedBadge', 'Locked')}
            </span>
          )}
        </div>

        {item.locked ? (
          // Read-only summary. We deliberately don't render any inputs
          // here so the admin can't accidentally type into a locked
          // entry. The invoice link is omitted for now — clicking
          // through to the bill belongs on a follow-up commit.
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {item.description || t('calendar.hourEntry.noDescription', 'No description.')}
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3" id="hour-entry-edit-form">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('calendar.hourEntry.startLabel', 'Start')}
                </label>
                <TimeField value={startTime} onChange={setStartTime} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('calendar.hourEntry.endLabel', 'End')}
                </label>
                <TimeField value={endTime} onChange={setEndTime} />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('calendar.hourEntry.descriptionLabel', 'Description (optional)')}
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={1000}
              />
            </div>
          </form>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          {item.locked ? <span /> : (
            <Button
              variant="outline"
              onClick={() => {
                if (window.confirm(t('calendar.hourEntry.confirmDelete',
                  'Delete these logged hours? This cannot be undone.') as string)) {
                  deleteMutation.mutate();
                }
              }}
              disabled={busy}
            >
              <Trash2 className="w-4 h-4 mr-1" aria-hidden />
              {t('calendar.hourEntry.delete', 'Delete')}
            </Button>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('calendar.hourEntry.close', 'Close')}
            </Button>
            {!item.locked && (
              <Button type="submit" form="hour-entry-edit-form" disabled={busy}>
                {updateMutation.isPending
                  ? t('calendar.hourEntry.saving', 'Saving…')
                  : t('calendar.hourEntry.submit', 'Save')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};
