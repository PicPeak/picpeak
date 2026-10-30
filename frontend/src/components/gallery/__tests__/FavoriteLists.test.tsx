/**
 * Named favourite lists (issue 2303), guest side.
 *
 * The bookmark saves to the list picked in the switcher, the switcher is
 * absent while the gallery has lists off (the bookmark then sends exactly what
 * it always sent), "Saved" shows the active list, and the dialog creates a
 * list and switches to it.
 */
import React from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoFavorites } from '../PhotoFavorites';
import { FavoriteListSwitcher } from '../FavoriteListSwitcher';
import { FavoriteListsDialog } from '../FavoriteListsDialog';
import {
  FavoriteListsContext,
  favoriteRowInList,
  inActiveList,
  useFavoriteListsState,
  type FavoriteListsValue,
} from '../../../contexts/FavoriteListsContext';
import { useGalleryFiltering, type GalleryFilterOptions } from '../hooks/useGalleryFiltering';
import type { Photo } from '../../../types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => {
        if (typeof fallback === 'string') return fallback;
        const options = fallback as { defaultValue?: string } | undefined;
        return options?.defaultValue ?? key;
      },
    }),
  };
});

const submitFeedback = vi.fn();
const getFavoriteLists = vi.fn();
const createFavoriteList = vi.fn();
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    submitFeedback: (...args: unknown[]) => submitFeedback(...args),
    getFavoriteLists: (...args: unknown[]) => getFavoriteLists(...args),
    createFavoriteList: (...args: unknown[]) => createFavoriteList(...args),
  },
}));

// Null (no provider) unless a test sets it: simple identity mode.
let guestIdentityValue: any = null;
vi.mock('../../../contexts/GuestIdentityContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/GuestIdentityContext')>('../../../contexts/GuestIdentityContext');
  return { ...actual, useGuestIdentityOptional: () => guestIdentityValue };
});

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({
  useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }),
}));

const lists = (overrides: Partial<FavoriteListsValue> = {}): FavoriteListsValue => ({
  slug: 'summer',
  lists: [{ id: 4, name: 'Print', count: 2 }, { id: 9, name: 'Album', count: 0 }],
  defaultCount: 3,
  maxLists: 20,
  maxNameLength: 60,
  activeListId: 4,
  setActiveListId: vi.fn(),
  managerOpen: false,
  openManager: vi.fn(),
  closeManager: vi.fn(),
  ...overrides,
});

const wrap = (value: FavoriteListsValue | null, ui: React.ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FavoriteListsContext.Provider value={value}>{ui}</FavoriteListsContext.Provider>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  submitFeedback.mockReset().mockResolvedValue({ created: true });
  getFavoriteLists.mockReset();
  createFavoriteList.mockReset();
  guestIdentityValue = null;
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

describe('the bookmark and the switcher', () => {
  it('saves to the active list', async () => {
    wrap(lists(), <PhotoFavorites photoId="7" gallerySlug="summer" isFavorited={false} favoriteCount={0} isEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledWith('summer', '7', expect.objectContaining({
      feedback_type: 'favorite', favorite_list_id: 4,
    })));
  });

  it('saves to the default list as null', async () => {
    wrap(lists({ activeListId: null }), <PhotoFavorites photoId="7" gallerySlug="summer" isFavorited={false} favoriteCount={0} isEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledWith('summer', '7', expect.objectContaining({ favorite_list_id: null })));
  });

  it('sends no list and shows no switcher while the gallery has lists off', async () => {
    wrap(null, (
      <>
        <PhotoFavorites photoId="7" gallerySlug="summer" isFavorited={false} favoriteCount={0} isEnabled />
        <FavoriteListSwitcher />
      </>
    ));
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalled());
    expect(submitFeedback.mock.calls[0][2]).not.toHaveProperty('favorite_list_id');
  });

  it('lists the default list and the guest\'s lists, switches, and opens the manager', () => {
    const value = lists();
    wrap(value, <FavoriteListSwitcher />);
    const select = screen.getByRole('combobox', { name: 'Save to list' }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'My favorites (3)', 'Print (2)', 'Album (0)', 'Manage lists…',
    ]);
    expect(select.value).toBe('4');

    fireEvent.change(select, { target: { value: '' } });
    expect(value.setActiveListId).toHaveBeenCalledWith(null);
    fireEvent.change(select, { target: { value: '9' } });
    expect(value.setActiveListId).toHaveBeenCalledWith(9);
    fireEvent.change(select, { target: { value: '__manage' } });
    expect(value.openManager).toHaveBeenCalled();
    expect(value.setActiveListId).toHaveBeenCalledTimes(2);
  });
});

describe('the dialog', () => {
  it('creates a list and makes it the active one', async () => {
    createFavoriteList.mockResolvedValue({ id: 12, name: 'Mum', count: 0 });
    const value = lists({ managerOpen: true });
    wrap(value, <FavoriteListsDialog />);

    fireEvent.change(screen.getByPlaceholderText('New list, e.g. Album'), { target: { value: '  Mum ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(createFavoriteList).toHaveBeenCalledWith('summer', 'Mum'));
    await waitFor(() => expect(value.setActiveListId).toHaveBeenCalledWith(12));
  });

  it('is not rendered while closed or without lists', () => {
    wrap(lists(), <FavoriteListsDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the active list', () => {
  it('reads the bookmark state and the Saved rows from the active list only', () => {
    expect(inActiveList([null, 4], 4)).toBe(true);
    expect(inActiveList([null], 4)).toBe(false);
    expect(inActiveList([null], null)).toBe(true);
    expect(favoriteRowInList(4, 4)).toBe(true);
    expect(favoriteRowInList(null, 4)).toBe(false);
    expect(favoriteRowInList(undefined, null)).toBe(true);
    // Lists off: every row counts.
    expect(favoriteRowInList(4, undefined)).toBe(true);
  });

  it('remembers the list per gallery, and falls back to the default list when it is gone', async () => {
    window.localStorage.setItem('picpeak:favorite-list:summer', '9');
    getFavoriteLists.mockResolvedValue({ default_count: 0, lists: [{ id: 4, name: 'Print', count: 0 }], max_lists: 20, max_name_length: 60 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useFavoriteListsState('summer', true), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current?.lists).toHaveLength(1));
    expect(result.current?.activeListId).toBeNull();
    expect(window.localStorage.getItem('picpeak:favorite-list:summer')).toBeNull();

    result.current?.setActiveListId(4);
    await waitFor(() => expect(result.current?.activeListId).toBe(4));
    expect(window.localStorage.getItem('picpeak:favorite-list:summer')).toBe('4');
  });

  it('is null, and fetches nothing, while the gallery has lists off', () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useFavoriteListsState('summer', false), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    expect(result.current).toBeNull();
    expect(getFavoriteLists).not.toHaveBeenCalled();
  });
});

describe('the Saved filter', () => {
  const photo = (id: number, favoriteCount: number) => ({
    id, filename: `IMG_${id}.jpg`, url: '', type: 'individual', size: 1,
    uploaded_at: `2026-01-0${id}T00:00:00Z`, favorite_count: favoriteCount,
  }) as unknown as Photo;
  const base: GalleryFilterOptions = {
    sourcePhotos: [photo(1, 1), photo(2, 1), photo(3, 0)],
    folderId: null, selectedCategoryId: null, searchTerm: '', sortBy: 'name', sortDesc: false,
    watermarkEnabled: false, slug: 'x', activeFilters: ['favorited'], activeColorFilters: [],
    mediaFilter: 'all', isGuestIdentityMode: false,
    // The viewer's active list holds photo 3 only.
    myFeedbackPhotoIds: { liked: new Set(), favorited: new Set([3]), rated: new Set(), commented: new Set() },
    selectedPersonIds: [], peopleMatchAny: false,
  };
  const ids = (options: Partial<GalleryFilterOptions>) =>
    renderHook(() => useGalleryFiltering({ ...base, ...options })).result.current.map((p) => p.id);

  it('shows the viewer\'s active list when the gallery has lists, in any identity mode', () => {
    expect(ids({ favoritedIsOwn: true })).toEqual([3]);
  });

  it('keeps the aggregate in simple mode without lists, as before', () => {
    expect(ids({})).toEqual([1, 2]);
  });
});

describe('creating a list with the real state', () => {
  const Harness: React.FC = () => {
    const value = useFavoriteListsState('summer', true);
    return (
      <FavoriteListsContext.Provider value={value}>
        <button type="button" onClick={() => value?.openManager()}>open</button>
        <span data-testid="active">{String(value?.activeListId)}</span>
        <FavoriteListsDialog />
      </FavoriteListsContext.Provider>
    );
  };

  it('keeps the new list active while the lists refetch', async () => {
    getFavoriteLists
      .mockResolvedValueOnce({ default_count: 0, lists: [{ id: 4, name: 'Print', count: 0 }], max_lists: 20, max_name_length: 60 })
      // The refetch after the create has not landed yet.
      .mockReturnValue(new Promise(() => {}));
    createFavoriteList.mockResolvedValue({ id: 12, name: 'Mum', count: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    await waitFor(() => expect(getFavoriteLists).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('null'));

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(await screen.findByPlaceholderText('New list, e.g. Album'), { target: { value: 'Mum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(createFavoriteList).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('12'));
    // Still the new list once every effect has run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('active').textContent).toBe('12');
    expect(window.localStorage.getItem('picpeak:favorite-list:summer')).toBe('12');
  });
});

describe('the switcher in guest identity mode', () => {
  it('asks for the guest\'s name before opening the list manager', async () => {
    let register: () => void = () => {};
    guestIdentityValue = {
      identityMode: 'guest',
      ensureIdentity: vi.fn(() => new Promise<void>((resolve) => { register = resolve; })),
    };
    const value = lists();
    wrap(value, <FavoriteListSwitcher />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__manage' } });
    expect(guestIdentityValue.ensureIdentity).toHaveBeenCalled();
    expect(value.openManager).not.toHaveBeenCalled();

    register();
    await waitFor(() => expect(value.openManager).toHaveBeenCalled());
  });

  it('stays closed when the guest cancels the prompt', async () => {
    guestIdentityValue = {
      identityMode: 'guest',
      ensureIdentity: vi.fn(() => Promise.reject(new Error('user_cancelled'))),
    };
    const value = lists();
    wrap(value, <FavoriteListSwitcher />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__manage' } });
    await waitFor(() => expect(guestIdentityValue.ensureIdentity).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(value.openManager).not.toHaveBeenCalled();
  });
});
