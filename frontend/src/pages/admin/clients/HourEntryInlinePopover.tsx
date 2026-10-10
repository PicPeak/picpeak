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

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { Badge, Button, Input, Modal, TimeField, useConfirm } from '../../../components/common';
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
  const confirm = useConfirm();
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

  return (
    <Modal
      open
      // Escape (Modal listens on the document, so it works while focus is
      // still on FullCalendar's canvas) and a backdrop click close, except
      // while a save or delete is in flight.
      onClose={() => { if (!busy) onClose(); }}
      size="sm"
      title={item.customerName || t('calendar.hourEntry.untitledCustomer', 'Hours')}
      description={`${item.entryDate} · ${item.startTime}–${item.endTime}`}
      footer={(
        <>
          {!item.locked && (
            <Button
              variant="outline"
              className="mr-auto"
              onClick={async () => {
                const ok = await confirm({
                  message: t('calendar.hourEntry.confirmDelete',
                    'Delete these logged hours? This cannot be undone.') as string,
                  variant: 'danger',
                  confirmLabel: t('calendar.hourEntry.deleteAction', 'Delete hours'),
                });
                if (ok) deleteMutation.mutate();
              }}
              disabled={busy}
              leftIcon={<Trash2 className="w-4 h-4" aria-hidden />}
            >
              {t('calendar.hourEntry.delete', 'Delete')}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('calendar.hourEntry.close', 'Close')}
          </Button>
          {!item.locked && (
            <Button type="submit" form="hour-entry-edit-form" disabled={busy}>
              {updateMutation.isPending
                ? t('calendar.hourEntry.saving', 'Saving…')
                : t('calendar.hourEntry.submit', 'Save hours')}
            </Button>
          )}
        </>
      )}
    >
        {item.locked && (
          <Badge
            icon={<Lock />}
            className="mb-3"
            title={t('calendar.hourEntry.lockedTooltip',
              'Already billed — Storno the invoice to edit.') as string}
          >
            {t('calendar.hourEntry.lockedBadge', 'Locked')}
          </Badge>
        )}
        {item.locked ? (
          // Read-only summary. We deliberately don't render any inputs
          // here so the admin can't accidentally type into a locked
          // entry. The invoice link is omitted for now — clicking
          // through to the bill belongs on a follow-up commit.
          <p className="text-sm text-muted">
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

    </Modal>
  );
};
