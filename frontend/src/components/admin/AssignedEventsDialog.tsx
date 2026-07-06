/**
 * AssignedEventsDialog (#354 follow-up).
 *
 * Modal dialog that lets an admin replace the full set of events a
 * single customer is assigned to. Mounted from the "Assigned events"
 * card on CustomerDetailPage via the "Manage galleries" button.
 *
 * UX shape — multi-select autocomplete (mirrors CustomerAccountPicker):
 *   - Search box at the top filters available events (admin-side
 *     event list, debounced 200ms).
 *   - Currently-selected events render as chips above the search.
 *   - Click a chip to remove. Click a search result to add.
 *   - Save replaces the customer's full assignment list via
 *     PUT /admin/customers/:id/events.
 *
 * Access revocation: removing a chip + saving deletes the
 * event_customer_assignments row. Gallery middleware re-checks that
 * row on every customer-minted JWT, so the customer's next request
 * to a removed gallery 403s with CUSTOMER_ASSIGNMENT_REVOKED — no
 * token-blacklist step needed on the frontend.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Calendar as CalendarIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../common';
import { customerAdminService } from '../../services/customerAdmin.service';
import { eventsService } from '../../services/events.service';
import type { Event as AdminEvent } from '../../services/events.service';

interface SelectedEvent {
  id: number;
  eventName: string;
  eventDate: string | null;
}

interface Props {
  customerId: number;
  isOpen: boolean;
  initial: SelectedEvent[];
  onClose: () => void;
  /** Called after a successful save so the parent can refetch. */
  onSaved: () => void;
}

export const AssignedEventsDialog: React.FC<Props> = ({ customerId, isOpen, initial, onClose, onSaved }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<SelectedEvent[]>(initial);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdminEvent[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Re-seed selection whenever the dialog is opened so we always start
  // from the server-current assignment list (not whatever the parent
  // last refetched before the previous close).
  useEffect(() => {
    if (isOpen) {
      setSelected(initial);
      setQuery('');
      setResults([]);
      // Autofocus the search input after the open animation settles.
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen, initial]);

  // Debounced event search. Aborts in-flight responses so a fast typer
  // doesn't see a stale result win the race.
  useEffect(() => {
    if (!isOpen) return undefined;
    const term = query.trim();
    if (!term) {
      setResults([]);
      setIsSearching(false);
      return undefined;
    }
    setIsSearching(true);
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const resp = await eventsService.getEvents(1, 25, undefined, term);
        const events = Array.isArray((resp as any)?.events)
          ? (resp as any).events as AdminEvent[]
          : ([] as AdminEvent[]);
        if (!cancelled) {
          // Filter out already-selected ids client-side. Cheaper than
          // round-tripping the selection state through the search API
          // and keeps the matching logic in one place.
          const selectedIds = new Set(selected.map((s) => s.id));
          setResults(events.filter((e) => !selectedIds.has(e.id)));
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 200);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [query, selected, isOpen]);

  const add = (ev: AdminEvent) => {
    setSelected((prev) => [
      ...prev,
      { id: ev.id, eventName: ev.event_name, eventDate: ev.event_date || null },
    ]);
    // Keep the typed query around so the admin can continue picking
    // additional matches from the same search (e.g. "Smith Wedding"
    // returns both the engagement + the wedding event; adding one
    // shouldn't force a re-type to add the other). The just-added
    // event drops out of the results automatically — the search
    // effect re-filters against the new `selected` set.
    searchInputRef.current?.focus();
  };

  const clearQuery = () => {
    setQuery('');
    setResults([]);
    searchInputRef.current?.focus();
  };

  const remove = (id: number) => {
    setSelected((prev) => prev.filter((s) => s.id !== id));
  };

  const initialIds = useMemo(() => new Set(initial.map((s) => s.id)), [initial]);
  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);
  const isDirty = useMemo(() => {
    if (selectedIds.size !== initialIds.size) return true;
    for (const id of selectedIds) {
      if (!initialIds.has(id)) return true;
    }
    return false;
  }, [selectedIds, initialIds]);

  const saveMutation = useMutation({
    mutationFn: () => customerAdminService.setEvents(customerId, [...selectedIds]),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      // Surface the diff so it's obvious revocations took effect.
      const parts: string[] = [];
      if (result.added) parts.push(t('customers.assignedEvents.addedN', '{{count}} added', { count: result.added }));
      if (result.removed) parts.push(t('customers.assignedEvents.removedN', '{{count}} removed', { count: result.removed }));
      toast.success(parts.length
        ? t('customers.assignedEvents.savedDiff', 'Assignments updated: {{parts}}', { parts: parts.join(', ') })
        : t('customers.assignedEvents.saved', 'Assignments updated'));
      onSaved();
      onClose();
    },
    onError: () => {
      toast.error(t('customers.assignedEvents.error', 'Could not update assignments'));
    },
  });

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        // Click-outside to close — only when the click was actually on
        // the backdrop, not on a child element that bubbled up.
        if (e.target === e.currentTarget && !saveMutation.isPending) onClose();
      }}
    >
      <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('customers.assignedEvents.title', 'Manage assigned galleries')}
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {t(
                'customers.assignedEvents.subtitle',
                'Pick every gallery this customer should be able to access from their dashboard. Removing a gallery here revokes access immediately on the customer\'s next request.',
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saveMutation.isPending}
            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 flex-shrink-0"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5 text-neutral-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Selected chips */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
              {t('customers.assignedEvents.currentLabel', 'Assigned galleries')}
              <span className="ml-1.5 normal-case text-neutral-400">({selected.length})</span>
            </label>
            {selected.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">
                {t('customers.assignedEvents.empty', 'No galleries assigned yet. Search below to add one.')}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {selected.map((s) => (
                  <li
                    key={s.id}
                    className="inline-flex items-center gap-2 pl-2 pr-1 py-1 rounded-full text-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
                  >
                    <CalendarIcon className="w-3.5 h-3.5 text-neutral-500" />
                    <span className="truncate max-w-[220px]">{s.eventName}</span>
                    <button
                      type="button"
                      onClick={() => remove(s.id)}
                      disabled={saveMutation.isPending}
                      aria-label={t('customers.assignedEvents.removeAria', 'Remove {{name}}', { name: s.eventName })}
                      className="p-0.5 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
                    >
                      <X className="w-3.5 h-3.5 text-neutral-500" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Search */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
              {t('customers.assignedEvents.searchLabel', 'Add a gallery')}
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('customers.assignedEvents.searchPlaceholder', 'Search by event name')}
                disabled={saveMutation.isPending}
                className="w-full pl-9 pr-9 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {/* Inline clear button — visible only while the query has
                  content. We keep the query through add() now so the
                  admin needs an explicit way to wipe it before starting
                  a new search. Esc would be lovely too but adding a
                  global key handler inside a modal is more risk than
                  this control is worth. */}
              {query && (
                <button
                  type="button"
                  onClick={clearQuery}
                  disabled={saveMutation.isPending}
                  aria-label={t('customers.assignedEvents.clearSearchAria', 'Clear search')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50"
                >
                  <X className="w-3.5 h-3.5 text-neutral-500" />
                </button>
              )}
            </div>

            {/* Results dropdown — inline (not a popover) since this is
                already inside a modal, no nested-popover headaches. */}
            <div className="mt-2 border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden bg-white dark:bg-neutral-800">
              {!query.trim() ? (
                <p className="px-3 py-3 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('customers.assignedEvents.searchHint', 'Start typing to find galleries.')}
                </p>
              ) : isSearching ? (
                <p className="px-3 py-3 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('common.searching', 'Searching…')}
                </p>
              ) : results.length === 0 ? (
                <p className="px-3 py-3 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('customers.assignedEvents.noResults', 'No matching galleries.')}
                </p>
              ) : (
                <ul role="listbox">
                  {results.map((ev) => (
                    <li key={ev.id}>
                      <button
                        type="button"
                        onClick={() => add(ev)}
                        disabled={saveMutation.isPending}
                        className="w-full text-left px-3 py-2 flex items-center justify-between gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <CalendarIcon className="w-4 h-4 flex-shrink-0 text-neutral-400" />
                          <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                            {ev.event_name}
                          </span>
                        </span>
                        {ev.event_date && (
                          <span className="text-xs text-neutral-500 dark:text-neutral-400 flex-shrink-0">
                            {ev.event_date}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-200 dark:border-neutral-700 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saveMutation.isPending}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending}
            isLoading={saveMutation.isPending}
          >
            {t('customers.assignedEvents.save', 'Save assignments')}
          </Button>
        </div>
      </div>
    </div>
  );
};
