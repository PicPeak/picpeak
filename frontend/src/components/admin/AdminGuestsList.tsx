import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, Eye, Download, UserPlus, Grid3x3, List } from 'lucide-react';
import {
  Card, Button, Loading, useConfirm, Badge, Notice, EmptyState, ErrorState,
  Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell,
} from '../common';
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
  const confirm = useConfirm();
  const { format: fmtDate } = useLocalizedDate();
  const [view, setView] = useState<View>('list');
  const [selectedGuest, setSelectedGuest] = useState<AdminGuest | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<number[]>([]);
  // Which row absorbs the others. Never defaulted: see the grouping comment.
  const [keepId, setKeepId] = useState<number | null>(null);
  const inviteModal = useModal();

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
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
      setKeepId(null);
    },
    errorMessage: () => t('admin.guests.mergedError', 'Failed to merge guests'),
  });

  const handleDelete = async (guest: AdminGuest) => {
    const ok = await confirm({
      message: t('admin.guests.forgetGuestConfirm', 'Remove this guest? Their picks will be anonymized but kept in aggregate totals.'),
      variant: 'danger',
      confirmLabel: t('admin.guests.forgetGuest', 'Remove guest'),
    });
    if (ok) deleteMutation.mutate(guest.id);
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

  const performMerge = async () => {
    if (mergeSelection.length < 2) {
      toast.warning(t('admin.guests.mergeSelectAtLeastTwo', 'Select at least 2 guests to merge'));
      return;
    }
    if (keepId === null || !mergeSelection.includes(keepId)) {
      toast.warning(t('admin.guests.mergePickKeep', 'Choose which entry to keep'));
      return;
    }
    const mergeIds = mergeSelection.filter((id) => id !== keepId);
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
    const ok = await confirm({
      message: confirmMsg,
      variant: 'danger',
      confirmLabel: t('admin.guests.mergeNow', 'Merge selected'),
    });
    if (ok) mergeMutation.mutate({ keepId, mergeIds });
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

    // Deliberately NOT ordered to imply a survivor (#1210 review, three
    // rounds on this one point). Every automatic rule was wrong somewhere:
    // most-feedback is guest-controlled, and oldest-first keeps the row whose
    // token expired while deleting the visitor's currently active identity —
    // the exact shape of the common case. The data does not say which row is
    // really the person, so the UI asks instead of guessing.
    return [...byGroup.values()].filter((group) => group.length > 1);
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
        <h3 className="text-lg font-semibold text-heading">
          {t('admin.guests.title', 'Guests')} ({guests.length})
        </h3>
        <div className="flex items-center gap-2">
          {mergeMode ? (
            <>
              <span className="text-sm text-soft">
                {t('admin.guests.mergeSelected', '{{count}} selected', { count: mergeSelection.length })}
              </span>
              {keepId === null && (
                <span className="text-sm text-warning-text">
                  {t('admin.guests.mergePickKeepHint', 'Pick the entry to keep')}
                </span>
              )}
              <Button variant="primary" size="sm" onClick={performMerge} disabled={mergeSelection.length < 2 || keepId === null}>
                {t('admin.guests.mergeNow', 'Merge selected')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setMergeMode(false); setMergeSelection([]); setKeepId(null); }}>
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
                <div className="absolute right-0 top-full mt-1 hidden group-hover:block bg-panel border border-line rounded shadow-lg z-10 min-w-[120px]">
                  {(['csv', 'txt', 'json'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => handleExportAll(fmt)}
                      className="block w-full text-left px-3 py-2 text-sm hover:bg-hover"
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
        <Notice
          tone="warning"
          className="mb-4"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setMergeMode(true);
                setMergeSelection(duplicateGroups[0].map((g) => g.id));
                setKeepId(null);
              }}
              className="shrink-0"
            >
              {t('admin.guests.reviewDuplicates', 'Review')}
            </Button>
          }
        >
          {t('admin.guests.duplicatesFound', {
            guests: duplicateCount,
            groups: duplicateGroups.length,
            defaultValue: '{{guests}} guest entries look like {{groups}} returning visitor(s) — same email, registered more than once. Their picks are split until they are merged.',
          })}
        </Notice>
      )}

      {isError && !data ? (
        <Card>
          <ErrorState
            size="inline"
            onRetry={() => refetch()}
            retrying={isFetching}
          />
        </Card>
      ) : guests.length === 0 ? (
        <Card>
          <EmptyState size="inline" title={t('admin.guests.empty', 'No guests have registered yet.')} />
        </Card>
      ) : (
            <Table>
              <TableHead>
                <tr>
                  {mergeMode && <TableHeaderCell className="w-8" />}
                  {mergeMode && (
                    <TableHeaderCell className="w-16">
                      {t('admin.guests.mergeKeepColumn', 'Keep')}
                    </TableHeaderCell>
                  )}
                  <TableHeaderCell>
                    {t('admin.guests.columns.name', 'Name')}
                  </TableHeaderCell>
                  <TableHeaderCell>
                    {t('admin.guests.columns.email', 'Email')}
                  </TableHeaderCell>
                  <TableHeaderCell align="right">
                    {t('admin.guests.columns.likes', 'Likes')}
                  </TableHeaderCell>
                  <TableHeaderCell align="right">
                    {t('admin.guests.columns.favorites', 'Favorites')}
                  </TableHeaderCell>
                  <TableHeaderCell align="right">
                    {t('admin.guests.columns.comments', 'Comments')}
                  </TableHeaderCell>
                  <TableHeaderCell align="right">
                    {t('admin.guests.columns.ratings', 'Ratings')}
                  </TableHeaderCell>
                  <TableHeaderCell align="right">
                    {t('admin.guests.columns.reactions', 'Reactions')}
                  </TableHeaderCell>
                  <TableHeaderCell align="right">
                    {t('admin.guests.columns.colorLabels', 'Color labels')}
                  </TableHeaderCell>
                  <TableHeaderCell>
                    {t('admin.guests.columns.lastSeen', 'Last seen')}
                  </TableHeaderCell>
                  <TableHeaderCell />
                </tr>
              </TableHead>
              <TableBody>
                {guests.map((guest) => (
                  <TableRow key={guest.id} className="hover:bg-hover-soft">
                    {mergeMode && (
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={t('admin.guests.mergeInclude', 'Include {{name}} in the merge', { name: guest.name })}
                          checked={mergeSelection.includes(guest.id)}
                          onChange={() => toggleMergeSelection(guest.id)}
                          className="w-4 h-4 text-accent rounded focus:ring-accent"
                        />
                      </TableCell>
                    )}
                    {mergeMode && (
                      <TableCell>
                        {/* The survivor, chosen rather than derived. Only
                            selectable among the rows actually being merged. */}
                        <input
                          type="radio"
                          name="merge-keep"
                          aria-label={t('admin.guests.mergeKeepRow', 'Keep {{name}}', { name: guest.name })}
                          checked={keepId === guest.id}
                          disabled={!mergeSelection.includes(guest.id)}
                          onChange={() => setKeepId(guest.id)}
                          className="w-4 h-4 text-accent focus:ring-accent disabled:opacity-40"
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-medium text-heading">
                      {guest.name}
                      {guest.email_verified_at && (
                        <span className="ml-2 text-xs text-success-text">✓</span>
                      )}
                    </TableCell>
                    <TableCell className="text-soft">
                      {guest.email || '—'}
                      {guest.duplicate_group && (
                        <Badge
                          tone="warning"
                          className="ml-2"
                          title={t('admin.guests.duplicateHint', 'Another entry on this gallery uses the same email — likely the same person registered twice.')}
                        >
                          {t('admin.guests.duplicateBadge', 'duplicate?')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell align="right" className="text-heading">
                      {guest.stats.likes}
                    </TableCell>
                    <TableCell align="right" className="text-heading">
                      {guest.stats.favorites}
                    </TableCell>
                    <TableCell align="right" className="text-heading">
                      {guest.stats.comments}
                    </TableCell>
                    <TableCell align="right" className="text-heading">
                      {guest.stats.ratings}
                    </TableCell>
                    <TableCell align="right" className="text-heading">
                      {guest.stats.reactions}
                    </TableCell>
                    <TableCell align="right" className="text-heading">
                      {guest.stats.color_labels ?? 0}
                    </TableCell>
                    <TableCell className="text-soft">
                      {fmtDate(guest.last_seen_at)}
                    </TableCell>
                    <TableCell align="right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedGuest(guest)}
                          className="p-1 text-muted hover:text-accent"
                          title={t('admin.guests.view', 'View details')}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <div className="relative group">
                          <button
                            type="button"
                            className="p-1 text-muted hover:text-accent"
                            title={t('admin.guests.export', 'Export')}
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <div className="absolute right-0 top-full mt-1 hidden group-hover:block bg-panel border border-line rounded shadow-lg z-10 min-w-[100px]">
                            {(['csv', 'txt', 'json'] as const).map((fmt) => (
                              <button
                                key={fmt}
                                onClick={() => handleExport(guest, fmt)}
                                className="block w-full text-left px-3 py-2 text-sm hover:bg-hover"
                              >
                                {fmt.toUpperCase()}
                              </button>
                            ))}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDelete(guest)}
                          className="p-1 text-muted hover:text-danger-text"
                          title={t('admin.guests.forgetGuest', 'Remove guest')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
