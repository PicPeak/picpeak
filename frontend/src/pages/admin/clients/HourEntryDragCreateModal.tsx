/**
 * HourEntryDragCreateModal — opens when the admin drag-selects an
 * empty time range on the admin calendar (E.7).
 *
 * Pre-filled fields from the drag:
 *   - entryDate  (the drag's start day, YYYY-MM-DD)
 *   - startTime  (HH:MM)
 *   - endTime    (HH:MM)
 *
 * Admin picks the customer through the existing CustomerPicker (C.5)
 * and optionally adds a description. Submit → POST /admin/customers/
 * :id/hour-entries (existing route from migration 129 + B.6 permission
 * split). On success, the calendar invalidates its `calendar-items`
 * query so the new entry appears as a green block.
 *
 * Per user spec: customer field is BLANK by default — no pre-fill from
 * the day's events even when there's exactly one event on that day.
 * Admin picks every time.
 *
 * The drag-create UX is gated by the existing route-layer permission:
 * the parent page already requires `customers.view`; the backend
 * enforces `customers.edit` on the POST. If the admin's role is
 * view-only, the modal opens but the submit fails with a clean 403
 * from the backend and the toast surfaces the error.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Button, Card, Input } from '../../../components/common';
import {
  CustomerPicker,
  type CustomerSummary,
} from '../../../components/admin/CustomerPicker';
import {
  customerAdminService,
  type CustomerAccountDetail,
} from '../../../services/customerAdmin.service';

export interface HourEntryDragCreateModalProps {
  /** Drag start day, YYYY-MM-DD. */
  entryDate: string;
  /** Drag start time, HH:MM. */
  startTime: string;
  /** Drag end time, HH:MM. */
  endTime: string;
  /** Close the modal without saving. */
  onClose: () => void;
  /**
   * Called after a successful create. Receives the saved entry's
   * details so the parent can imperatively add it to FullCalendar
   * (`calendarRef.getApi().addEvent(...)`) — bypasses FC's
   * events-prop diffing which was silently dropping new entries (H.1).
   */
  onCreated: (created: {
    id: number;
    customerAccountId: number;
    customerName: string | null;
    entryDate: string;
    startTime: string;
    endTime: string;
    description: string | null;
  }) => void;
}

export const HourEntryDragCreateModal: React.FC<HourEntryDragCreateModalProps> = ({
  entryDate,
  startTime,
  endTime,
  onClose,
  onCreated,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Owned by the parent triple per the CustomerPicker contract.
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerIsPassive, setCustomerIsPassive] = useState(false);
  // H.2 — track the picked customer's hour-logging eligibility so the
  // Save button can refuse the click upfront. Backend still 409s on
  // save as a defence-in-depth; this is the matching UI guard.
  const [customerHoursAllowed, setCustomerHoursAllowed] = useState(true);
  const [description, setDescription] = useState('');

  const createMutation = useMutation({
    mutationFn: () => {
      if (!customerId) throw new Error('Customer required');
      return customerAdminService.createHourEntry(customerId, {
        entryDate,
        startTime,
        endTime,
        description: description.trim() || null,
      });
    },
    // H.1 — Three prior approaches (F.7 await refetch, G.3 setQueriesData
    // optimistic) didn't reliably make the new block visible. The user
    // reproduced "disappears" on all three. Root cause: FullCalendar's
    // React wrapper diffs the `events` prop by content hash and was
    // silently dropping the just-added entry.
    //
    // This commit hands off the created entry to the PARENT (CalendarPage),
    // which uses FC's imperative `addEvent` API to push the chip directly
    // into FC's eventStore — bypasses React state, the useQuery cache,
    // AND the events-prop diffing. The block appears as soon as the
    // modal closes.
    //
    // Background invalidate still runs so a subsequent navigation or
    // refresh syncs against the server-computed shape (customerName
    // from joins, status updates).
    onSuccess: (result) => {
      toast.success(t('calendar.hourEntry.created', 'Hours logged.'));
      if (customerId) {
        // I.4 — merge the new entry into EVERY cached calendar-items
        // range. addEvent (in the parent's onCreated handler) gives
        // us the immediate visual; this keeps the react-query cache
        // honest so when the admin navigates to next week and back,
        // the cached payload for the original range still contains
        // the new entry — otherwise FC rebuilds its eventStore from
        // a stale cache and wipes the chip.
        //
        // We deliberately do NOT invalidate — invalidate would refetch
        // immediately and FC's events-prop diffing has been shown to
        // drop the new entry mid-session (the reason H.1 went
        // imperative in the first place). setQueriesData mutates the
        // cache in-place; the visual is delivered by addEvent now and
        // by the cache on every subsequent datesSet.
        const optimisticItem = {
          kind: 'hours' as const,
          id: result.id,
          customerAccountId: customerId,
          entryDate,
          startTime,
          endTime,
          description: description.trim() || null,
          status: result.status,
          invoiceId: result.invoiceId ?? null,
          invoiceStatus: null,
          locked: false,
          customerName: customerLabel || null,
        };
        queryClient.setQueriesData(
          { queryKey: ['calendar-items'] },
          (old: { items?: unknown[]; range?: unknown } | undefined) => {
            if (!old || !Array.isArray(old.items)) return old;
            // Don't double-insert if a competing tab's refetch already
            // delivered the entry.
            const already = old.items.some((it: unknown) => {
              const x = it as { kind?: string; id?: number };
              return !!x && x.kind === 'hours' && x.id === result.id;
            });
            if (already) return old;
            return { ...old, items: [...old.items, optimisticItem] };
          },
        );
        onCreated({
          id: result.id,
          customerAccountId: customerId,
          customerName: customerLabel || null,
          entryDate,
          startTime,
          endTime,
          description: description.trim() || null,
        });
      }
      // The per-customer hour-entries query (used by the standalone
      // hours page) is on a different observer, so invalidating it
      // doesn't affect FC.
      queryClient.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
    },
    onError: (err: unknown) => {
      // I.2 — detect FEATURE_OFF (server-side hour logging disabled)
      // and surface a human message instead of the raw axios string.
      // The lone backend path that emits this code is
      // customerHoursService.createEntry's per-customer + master flag
      // check; on drag-move/resize this can fire if the per-customer
      // flag changed since the entry was created.
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
      toast.error(t('calendar.hourEntry.createFailed', { message: msg, defaultValue: `Couldn't save: ${msg}` }) as string);
    },
  });

  // H.2 — refuse the click when the picked customer has hour logging
  // OFF (backend would 409 anyway; this skips the round-trip + toast).
  const canSubmit = !!customerId && customerHoursAllowed && !createMutation.isPending;

  // Submit handler shared by the Save button + the wrapping form's
  // implicit Enter-key submit. Wrapped in a single guard so a stale
  // press with no customer selected just no-ops instead of throwing
  // through the mutationFn.
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate();
  };

  // I.6 — close on Escape via a document-level listener. A React
  // onKeyDown on the modal's outer div ONLY fires when focus is
  // already inside the modal subtree — but after the modal opens
  // (from FullCalendar's `select` callback), focus stays on FC's
  // canvas / body, so the bubbled-up handler never sees the keydown.
  // Listening on document catches Escape regardless of where focus
  // sits. Guarded against the mutation being in-flight so the admin
  // can't cancel mid-save and end up with a saved-but-modal-closed
  // race.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !createMutation.isPending) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [createMutation.isPending, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4"
      onClick={(e) => {
        // Click on the backdrop closes; clicks inside the card stop
        // here. (Esc handled via document-level listener above.)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card padding="lg" className="w-full max-w-md">
        <h2 className="font-semibold text-lg mb-1">
          {t('calendar.hourEntry.createTitle', 'Log hours')}
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
          {/* The pre-filled range is part of the page state, not editable
              from this modal. Admin can edit start/end after creating
              via the inline-edit popover (also in this commit). */}
          {entryDate} · {startTime}–{endTime}
        </p>
        {/* Wrap fields in a form so pressing Enter inside the
            description input fires the submit handler — matches the
            keyboard expectation on every other admin modal. The Save
            button keeps its onClick for users who navigate via mouse. */}
        <form onSubmit={submit}>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('calendar.hourEntry.customerLabel', 'Customer')}
            </label>
            <CustomerPicker
              value={customerId}
              label={customerLabel}
              isPassive={customerIsPassive}
              // F.6 — surface the hours-logging-eligible badge so admin
              // sees up front that a customer with feature_hours_logging
              // OFF would 409 the save.
              requireFeature="hoursLogging"
              onSelect={(c: CustomerSummary) => {
                setCustomerId(c.id);
                setCustomerLabel(
                  c.companyName
                    || [c.firstName, c.lastName].filter(Boolean).join(' ')
                    || c.displayName
                    || c.email
                    || `#${c.id}`,
                );
                setCustomerIsPassive(Boolean(c.isPassive));
                // H.2 — refuse Save when feature_hours_logging is OFF.
                // featureHoursLogging is optional on the search summary
                // (defaults false on un-G.2 backends); treat undefined
                // as eligible so older backends don't block all saves.
                setCustomerHoursAllowed(c.featureHoursLogging !== false);
              }}
              onCreate={(c: CustomerAccountDetail) => {
                setCustomerId(c.id);
                setCustomerLabel(c.companyName || c.displayName || c.email || `#${c.id}`);
                setCustomerIsPassive(Boolean(c.isPassive));
                // Freshly-created customers default with hour-logging
                // disabled until admin flips it on per-customer.
                setCustomerHoursAllowed(c.featureHoursLogging !== false);
              }}
              onClear={() => {
                setCustomerId(null);
                setCustomerLabel('');
                setCustomerIsPassive(false);
                setCustomerHoursAllowed(true);
              }}
              searchPlaceholder={t('calendar.hourEntry.customerSearch', 'Search by email or company…') as string}
            />
            {/* H.2 — explicit warning when the picked customer is
                ineligible. Without this the admin sees only the
                badge on the option row, then a 409 toast after Save.
                With this, the Save button is disabled and the reason
                is visible. */}
            {customerId && !customerHoursAllowed && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                {t('calendar.hourEntry.customerLoggingDisabled',
                  "This customer has hour logging disabled. Enable it on the customer's detail page to log hours.")}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              {t('calendar.hourEntry.descriptionLabel', 'Description (optional)')}
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              placeholder={t('calendar.hourEntry.descriptionPlaceholder', 'Editing / shoot / travel…') as string}
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            {t('calendar.hourEntry.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            disabled={!canSubmit}
          >
            {createMutation.isPending
              ? t('calendar.hourEntry.saving', 'Saving…')
              : t('calendar.hourEntry.submit', 'Save hours')}
          </Button>
        </div>
        </form>
      </Card>
    </div>
  );
};
