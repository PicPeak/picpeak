import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { Button } from '../common';
import { feedbackService } from '../../services/feedback.service';
import { favoriteListsQueryKey, useFavoriteListsOptional } from '../../contexts/FavoriteListsContext';
import { feedbackLockKind } from '../../utils/feedbackLock';
import { useGalleryDialog } from './hooks/useGalleryDialog';

/**
 * Create, rename and delete the guest's favourite lists (issue 2303). The
 * default list is fixed: it has no name to change and cannot be deleted.
 * Deleting a list deletes the favourites in it, which the confirm step says.
 */
export const FavoriteListsDialog: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const favoriteLists = useFavoriteListsOptional();
  const panelRef = useRef<HTMLDivElement>(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const open = !!favoriteLists?.managerOpen;
  const close = () => {
    setEditing(null);
    setConfirmingDelete(null);
    favoriteLists?.closeManager();
  };
  useGalleryDialog({ open, onClose: close, panelRef });

  if (!favoriteLists || !open) return null;
  const { slug, lists, maxLists, maxNameLength, activeListId, setActiveListId } = favoriteLists;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: favoriteListsQueryKey(slug) });
    queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
    queryClient.invalidateQueries({ queryKey: ['photo-feedback', slug] });
  };

  const explain = (error: unknown) => {
    // A finished selection: feedbackService already said so.
    if (feedbackLockKind(error)) return;
    const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
    if (code === 'FAVORITE_LIST_NAME_TAKEN') {
      toast.error(t('gallery.favoriteLists.nameTaken', 'You already have a list with this name.'));
    } else if (code === 'FAVORITE_LIST_LIMIT_REACHED') {
      toast.error(t('gallery.favoriteLists.limitReached', { count: maxLists, defaultValue: 'You can have up to {{count}} lists.' }));
    } else {
      toast.error(t('gallery.favoriteLists.saveError', 'The list could not be saved.'));
    }
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      explain(error);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    run(async () => {
      const list = await feedbackService.createFavoriteList(slug, name);
      setNewName('');
      // A new list is where the guest means to save next.
      setActiveListId(list.id);
      refresh();
    });
  };

  const handleRename = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || !editing.name.trim()) return;
    run(async () => {
      await feedbackService.renameFavoriteList(slug, editing.id, editing.name.trim());
      setEditing(null);
      refresh();
    });
  };

  const handleDelete = (listId: number) => run(async () => {
    await feedbackService.deleteFavoriteList(slug, listId);
    setConfirmingDelete(null);
    if (activeListId === listId) setActiveListId(null);
    refresh();
    // The photos' favourite counts may have changed.
    queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
  });

  const title = t('gallery.favoriteLists.title', 'Your lists');
  const atLimit = lists.length >= maxLists;

  // On the body: the dialog also opens over the lightbox.
  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000] p-4"
      onClick={close}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card-themed text-theme p-5 sm:p-6 max-w-md w-full max-h-[85vh] overflow-y-auto"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-lg font-semibold text-theme">{title}</h2>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close', 'Close')}
            className="text-muted-theme hover:text-theme"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-muted-theme mb-4">
          {t('gallery.favoriteLists.intro', 'Sort your saved photos into lists. The bookmark saves to the list you pick.')}
        </p>

        <ul className="flex flex-col gap-2 mb-4">
          <li className="flex items-center justify-between gap-2 py-1.5">
            <span className="min-w-0 truncate">{t('gallery.favoriteLists.defaultList', 'My favorites')}</span>
            <span className="text-xs text-muted-theme shrink-0">{t('gallery.favoriteLists.defaultHint', 'Default list')}</span>
          </li>
          {lists.map((list) => (
            <li key={list.id} className="flex items-center gap-2 py-1.5 border-t border-border-token">
              {editing?.id === list.id ? (
                <form onSubmit={handleRename} className="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    autoFocus
                    value={editing.name}
                    maxLength={maxNameLength}
                    onChange={(e) => setEditing({ id: list.id, name: e.target.value })}
                    aria-label={t('gallery.favoriteLists.nameLabel', 'List name')}
                    className="input-themed rounded-lg px-2 py-1 text-sm flex-1 min-w-0"
                  />
                  <button type="submit" disabled={busy} aria-label={t('common.save', 'Save')} className="text-muted-theme hover:text-theme">
                    <Check className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => setEditing(null)} aria-label={t('common.cancel', 'Cancel')} className="text-muted-theme hover:text-theme">
                    <X className="w-4 h-4" />
                  </button>
                </form>
              ) : confirmingDelete === list.id ? (
                <div className="flex flex-col gap-2 flex-1 min-w-0">
                  <span className="text-sm">
                    {t('gallery.favoriteLists.confirmDelete', {
                      name: list.name,
                      count: list.count,
                      defaultValue: 'Delete "{{name}}" and the {{count}} photos saved in it?',
                    })}
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setConfirmingDelete(null)}>
                      {t('common.cancel', 'Cancel')}
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => handleDelete(list.id)}>
                      {t('gallery.favoriteLists.delete', 'Delete list')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="min-w-0 truncate flex-1">{list.name}</span>
                  <span className="text-xs text-muted-theme shrink-0">{list.count}</span>
                  <button
                    type="button"
                    onClick={() => setEditing({ id: list.id, name: list.name })}
                    aria-label={t('gallery.favoriteLists.rename', { name: list.name, defaultValue: 'Rename {{name}}' })}
                    className="text-muted-theme hover:text-theme shrink-0"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(list.id)}
                    aria-label={t('gallery.favoriteLists.deleteNamed', { name: list.name, defaultValue: 'Delete {{name}}' })}
                    className="text-muted-theme hover:text-theme shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>

        {atLimit ? (
          <p className="text-sm text-muted-theme">
            {t('gallery.favoriteLists.limitReached', { count: maxLists, defaultValue: 'You can have up to {{count}} lists.' })}
          </p>
        ) : (
          <form onSubmit={handleCreate} className="flex items-center gap-2">
            <input
              value={newName}
              maxLength={maxNameLength}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('gallery.favoriteLists.newPlaceholder', 'New list, e.g. Album')}
              aria-label={t('gallery.favoriteLists.nameLabel', 'List name')}
              className="input-themed rounded-lg px-3 py-2 text-sm flex-1 min-w-0"
            />
            <Button type="submit" size="sm" variant="primary" disabled={busy || !newName.trim()}>
              {t('gallery.favoriteLists.create', 'Add')}
            </Button>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
};
