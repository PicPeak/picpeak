import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { feedbackService, type FavoriteList } from '../services/feedback.service';

/**
 * Named favourite lists (issue 2303): which list the bookmark saves to, the
 * guest's lists, and the dialog that manages them. GalleryView owns the state
 * (the "Saved" filter reads the active list too) and provides it; the bookmark
 * in the lightbox and the feedback panel reads it from here.
 *
 * Null when the gallery has lists off: every consumer then behaves exactly as
 * before lists existed.
 */
export interface FavoriteListsValue {
  slug: string;
  lists: FavoriteList[];
  /** Photos in the default list. */
  defaultCount: number;
  maxLists: number;
  maxNameLength: number;
  /** The list the bookmark saves to; null is the default list. */
  activeListId: number | null;
  setActiveListId: (listId: number | null) => void;
  managerOpen: boolean;
  openManager: () => void;
  closeManager: () => void;
}

export const FavoriteListsContext = createContext<FavoriteListsValue | null>(null);

export const useFavoriteListsOptional = () => useContext(FavoriteListsContext);

export const favoriteListsQueryKey = (slug: string) => ['favorite-lists', slug] as const;

// The active list, per gallery, in this browser. A per-viewer convenience:
// unreadable storage (private mode, blocked site data) means the default list.
const storageKey = (slug: string) => `picpeak:favorite-list:${slug}`;

function readStoredListId(slug: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    const id = raw === null ? NaN : Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function writeStoredListId(slug: string, listId: number | null) {
  try {
    if (listId === null) window.localStorage.removeItem(storageKey(slug));
    else window.localStorage.setItem(storageKey(slug), String(listId));
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}

/** Is the photo in the active list, from the photo's my_feedback? */
export function inActiveList(
  favoriteListIds: ReadonlyArray<number | null> | undefined,
  activeListId: number | null,
): boolean {
  return !!favoriteListIds && favoriteListIds.includes(activeListId);
}

/**
 * Does a /my-feedback favourite row count for "Saved"? With lists, only rows
 * in the active list; `activeListId` undefined (lists off) takes every row.
 */
export function favoriteRowInList(
  rowListId: number | null | undefined,
  activeListId: number | null | undefined,
): boolean {
  return activeListId === undefined || (rowListId ?? null) === activeListId;
}

/** The state behind the provider; null while the gallery has lists off. */
export function useFavoriteListsState(slug: string, enabled: boolean): FavoriteListsValue | null {
  const { data } = useQuery({
    queryKey: favoriteListsQueryKey(slug),
    queryFn: () => feedbackService.getFavoriteLists(slug),
    enabled: enabled && !!slug,
    staleTime: 30 * 1000,
  });
  const [activeListId, setActive] = useState<number | null>(() => readStoredListId(slug));
  const [managerOpen, setManagerOpen] = useState(false);

  const setActiveListId = useCallback((listId: number | null) => {
    setActive(listId);
    writeStoredListId(slug, listId);
  }, [slug]);

  // A remembered list that is gone (deleted, or another guest on this
  // device) falls back to the default list.
  useEffect(() => {
    if (!data || activeListId === null) return;
    if (!data.lists.some((list) => list.id === activeListId)) setActiveListId(null);
  }, [data, activeListId, setActiveListId]);

  const openManager = useCallback(() => setManagerOpen(true), []);
  const closeManager = useCallback(() => setManagerOpen(false), []);

  return useMemo(() => (enabled ? {
    slug,
    lists: data?.lists ?? [],
    defaultCount: data?.default_count ?? 0,
    maxLists: data?.max_lists ?? 20,
    maxNameLength: data?.max_name_length ?? 60,
    // Until the lists load, a remembered id is not known to be valid yet:
    // save to the default list rather than to a list that may be gone.
    activeListId: data ? activeListId : null,
    setActiveListId,
    managerOpen,
    openManager,
    closeManager,
  } : null), [enabled, slug, data, activeListId, setActiveListId, managerOpen, openManager, closeManager]);
}
