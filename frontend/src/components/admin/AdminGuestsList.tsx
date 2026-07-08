import React, { useState } from 'react';
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
    const keepName = data?.guests.find((g) => g.id === keepId)?.name;
    const confirmMsg = t(
      'admin.guests.mergeConfirm',
      'Merge {{count}} guests into {{name}}? This cannot be undone.',
      { count: mergeSelection.length, name: keepName || '#' + keepId }
    );
    if (window.confirm(confirmMsg)) {
      mergeMutation.mutate({ keepId, mergeIds });
    }
  };

  if (isLoading) {
    return <Loading size="lg" text={t('admin.guests.loading', 'Loading guests...')} />;
  }

  const guests = data?.guests || [];

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
