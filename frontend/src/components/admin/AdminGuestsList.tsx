import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, Eye, Download, UserPlus, Grid3x3, List } from 'lucide-react';
import { Card, Button, Loading } from '../common';
import { guestsService, AdminGuest } from '../../services/guests.service';
import { AdminGuestDetail } from './AdminGuestDetail';
import { GuestSelectionsAggregate } from './GuestSelectionsAggregate';
import { GuestInviteDialog } from './GuestInviteDialog';
import { toast } from 'react-toastify';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useMutationWithToast, useModal } from '../../hooks';

interface AdminGuestsListProps {
  eventId: number;
  eventName?: string;
}

type View = 'list' | 'aggregate';

export const AdminGuestsList: React.FC<AdminGuestsListProps> = ({ eventId, eventName }) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const [view, setView] = useState<View>('list');
  const [selectedGuest, setSelectedGuest] = useState<AdminGuest | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<number[]>([]);
  const inviteModal = useModal();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-guests', eventId],
    queryFn: () => guestsService.getEventGuests(eventId),
  });

  const deleteMutation = useMutationWithToast({
    mutationFn: (guestId: number) => guestsService.deleteGuest(eventId, guestId),
    successMessage: t('admin.guests.deletedToast', 'Guest removed'),
    invalidateKeys: [['admin-guests', eventId]],
    errorMessage: () => t('admin.guests.deletedError', 'Failed to remove guest'),
  });

  const mergeMutation = useMutationWithToast({
    mutationFn: ({ keepId, mergeIds }: { keepId: number; mergeIds: number[] }) =>
      guestsService.mergeGuests(eventId, keepId, mergeIds),
    successMessage: t('admin.guests.mergedToast', 'Guests merged'),
    invalidateKeys: [['admin-guests', eventId]],
    onSuccess: () => {
      setMergeMode(false);
      setMergeSelection([]);
    },
    errorMessage: () => t('admin.guests.mergedError', 'Failed to merge guests'),
  });

  const handleDelete = (guest: AdminGuest) => {
    if (window.confirm(t('admin.guests.forgetGuestConfirm', 'Remove this guest? Their picks will be anonymized but kept in aggregate totals.'))) {
      deleteMutation.mutate(guest.id);
    }
  };

  const handleExport = async (guest: AdminGuest, format: 'txt' | 'csv' | 'json') => {
    try {
      const blob = await guestsService.exportGuest(eventId, guest.id, format);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${guest.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error(t('admin.guests.exportError', 'Export failed'));
    }
  };

  const handleExportAll = async (format: 'txt' | 'csv' | 'json') => {
    try {
      const blob = await guestsService.exportAllGuests(eventId, format);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `event-${eventId}-guests.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error(t('admin.guests.exportError', 'Export failed'));
    }
  };

  const toggleMergeSelection = (id: number) => {
    setMergeSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const performMerge = () => {
    if (mergeSelection.length < 2) {
      toast.warning(t('admin.guests.mergeSelectAtLeastTwo', 'Select at least 2 guests to merge'));
      return;
    }
    const [keepId, ...mergeIds] = mergeSelection;
    const keep = data?.guests.find((g) => g.id === keepId);
    // Name plus email (#1210 review): duplicates are the same person, so the
    // names are usually identical — "Merge 2 guests into Tina?" told the admin
    // nothing about which Tina is about to absorb the other.
    const keepLabel = keep
      ? [keep.name, keep.email].filter(Boolean).join(' · ')
      : `#${keepId}`;
    const confirmMsg = t(
      'admin.guests.mergeConfirm',
      'Merge {{count}} guests into {{name}}? This cannot be undone.',
      { count: mergeSelection.length, name: keepLabel }
    );
    if (window.confirm(confirmMsg)) {
      mergeMutation.mutate({ keepId, mergeIds });
    }
  };

  // Stable identity so the duplicate grouping below is not recomputed on
  // every render by a fresh [] literal.
  const guests = useMemo(() => data?.guests || [], [data?.guests]);

  // Derived from the rows the badges render, not from the API's summary count,
  // so a banner saying "3 entries" can never sit above rows where only 2 are
  // badged. The API returns the summary too; it is a cheap cross-check, not a
  // second source of truth.
  const duplicateGroups = useMemo(() => {
    const byGroup = new Map<string, AdminGuest[]>();
    for (const g of guests) {
      if (!g.duplicate_group) continue;
      if (!byGroup.has(g.duplicate_group)) byGroup.set(g.duplicate_group, []);
      byGroup.get(g.duplicate_group)!.push(g);
    }

    // The order inside a group is not cosmetic: performMerge keeps
    // mergeSelection[0] and soft-deletes the rest, so whichever row this puts
    // first is the one that survives (#1210 review). Left in API order that
    // was newest-first, which would discard an older, email-verified row with
    // most of the picks in favour of a fresh re-registration.
    //
    // Verified first, then whoever holds the most feedback, then the oldest —
    // the row with the strongest claim to being the real person. Still only a
    // proposal: the admin sees it ticked and can change it before merging.
    const rank = (g: AdminGuest) => [
      g.email_verified_at ? 0 : 1,
      -(g.stats?.distinct_photos ?? 0),
      new Date(g.created_at).getTime(),
    ];
    return [...byGroup.values()]
      .filter((group) => group.length > 1)
      .map((group) => [...group].sort((a, b) => {
        const ra = rank(a); const rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
        return 0;
      }));
  }, [guests]);
  const duplicateCount = duplicateGroups.reduce((n, group) => n + group.length, 0);

  if (isLoading) {
    return <Loading size="lg" text={t('admin.guests.loading', 'Loading guests...')} />;
  }


  if (view === 'aggregate') {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setView('list')} leftIcon={<List className="w-4 h-4" />}>
              {t('admin.guests.backToList', 'Back to list')}
            </Button>
          </div>
        </div>
        <GuestSelectionsAggregate eventId={eventId} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {t('admin.guests.title', 'Guests')} ({guests.length})
        </h3>
        <div className="flex items-center gap-2">
          {mergeMode ? (
            <>
              <span className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('admin.guests.mergeSelected', '{{count}} selected', { count: mergeSelection.length })}
              </span>
              <Button variant="primary" size="sm" onClick={performMerge} disabled={mergeSelection.length < 2}>
                {t('admin.guests.mergeNow', 'Merge selected')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setMergeMode(false); setMergeSelection([]); }}>
                {t('common.cancel', 'Cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<UserPlus className="w-4 h-4" />}
                onClick={inviteModal.open}
              >
                {t('admin.guests.createInvite', 'Create invite')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Grid3x3 className="w-4 h-4" />}
                onClick={() => setView('aggregate')}
              >
                {t('admin.guests.aggregateView', 'By popularity')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMergeMode(true)}
                disabled={guests.length < 2}
              >
                {t('admin.guests.mergeMode', 'Merge')}
              </Button>
              <div className="relative group">
                <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />}>
                  {t('admin.guests.exportAll', 'Export all')}
                </Button>
                <div className="absolute right-0 top-full mt-1 hidden group-hover:block bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded shadow-lg z-10 min-w-[120px]">
                  {(['csv', 'txt', 'json'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => handleExportAll(fmt)}
                      className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700"
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* The one thing the admin could not see (#1210). Registration always
          inserts, so a client returning after their token expired — or on a
          second device — becomes another row and their picks split across the
          copies. Merging was already here; knowing WHICH rows to merge was
          not, and a split selection is invisible until someone notices two
          "Tina"s with half the likes each.

          Preselects the group rather than merging for them: which row survives
          decides which name and verification state the merged guest keeps, and
          that is the admin's call, not a default. */}
      {duplicateGroups.length > 0 && !mergeMode && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 flex items-center justify-between gap-4">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {t('admin.guests.duplicatesFound', {
              guests: duplicateCount,
              groups: duplicateGroups.length,
              defaultValue: '{{guests}} guest entries look like {{groups}} returning visitor(s) — same email, registered more than once. Their picks are split until they are merged.',
            })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setMergeMode(true);
              setMergeSelection(duplicateGroups[0].map((g) => g.id));
            }}
            className="shrink-0"
          >
            {t('admin.guests.reviewDuplicates', 'Review')}
          </Button>
        </div>
      )}

      {guests.length === 0 ? (
        <Card>
          <div className="p-8 text-center text-neutral-500 dark:text-neutral-400">
            {t('admin.guests.empty', 'No guests have registered yet.')}
          </div>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
                <tr>
                  {mergeMode && <th className="px-4 py-3 w-8" />}
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.name', 'Name')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.email', 'Email')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.likes', 'Likes')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.favorites', 'Favorites')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.comments', 'Comments')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.ratings', 'Ratings')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.reactions', 'Reactions')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.colorLabels', 'Color labels')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400 uppercase">
                    {t('admin.guests.columns.lastSeen', 'Last seen')}
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-700">
                {guests.map((guest) => (
                  <tr key={guest.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800">
                    {mergeMode && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={mergeSelection.includes(guest.id)}
                          onChange={() => toggleMergeSelection(guest.id)}
                          className="w-4 h-4 text-accent rounded focus:ring-primary-500"
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-100">
                      {guest.name}
                      {guest.email_verified_at && (
                        <span className="ml-2 text-xs text-green-600">✓</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-600 dark:text-neutral-400">
                      {guest.email || '—'}
                      {guest.duplicate_group && (
                        <span
                          className="ml-2 inline-block rounded px-1.5 py-0.5 text-xs bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200"
                          title={t('admin.guests.duplicateHint', 'Another entry on this gallery uses the same email — likely the same person registered twice.')}
                        >
                          {t('admin.guests.duplicateBadge', 'duplicate?')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-neutral-900 dark:text-neutral-100">
                      {guest.stats.likes}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-neutral-900 dark:text-neutral-100">
                      {guest.stats.favorites}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-neutral-900 dark:text-neutral-100">
                      {guest.stats.comments}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-neutral-900 dark:text-neutral-100">
                      {guest.stats.ratings}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-neutral-900 dark:text-neutral-100">
                      {guest.stats.reactions}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-neutral-900 dark:text-neutral-100">
                      {guest.stats.color_labels ?? 0}
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-600 dark:text-neutral-400">
                      {fmtDate(guest.last_seen_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedGuest(guest)}
                          className="p-1 text-neutral-500 hover:text-accent"
                          title={t('admin.guests.view', 'View details')}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <div className="relative group">
                          <button
                            type="button"
                            className="p-1 text-neutral-500 hover:text-accent"
                            title={t('admin.guests.export', 'Export')}
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <div className="absolute right-0 top-full mt-1 hidden group-hover:block bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded shadow-lg z-10 min-w-[100px]">
                            {(['csv', 'txt', 'json'] as const).map((fmt) => (
                              <button
                                key={fmt}
                                onClick={() => handleExport(guest, fmt)}
                                className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700"
                              >
                                {fmt.toUpperCase()}
                              </button>
                            ))}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDelete(guest)}
                          className="p-1 text-neutral-500 hover:text-red-600"
                          title={t('admin.guests.forgetGuest', 'Remove guest')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {selectedGuest && (
        <AdminGuestDetail
          eventId={eventId}
          guest={selectedGuest}
          onClose={() => setSelectedGuest(null)}
        />
      )}

      {inviteModal.isOpen && (
        <GuestInviteDialog
          eventId={eventId}
          eventName={eventName}
          onClose={() => {
            inviteModal.close();
            refetch();
          }}
        />
      )}
    </div>
  );
};
