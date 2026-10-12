/**
 * Issue 1891: a like must not refetch the whole photo list. The toggled
 * photo's row is refreshed from one per-photo request and written into the
 * cached list in place; everything else still refetches.
 */
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

import { useFeedbackChange } from '../useFeedbackChange';
import type { GalleryData } from '../../../../types';

const getPhotoFeedback = vi.fn();
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { getPhotoFeedback: (...args: unknown[]) => getPhotoFeedback(...args) },
}));

const LIST_KEY = ['gallery-photos', 'summer', 'all', undefined];
const feedback = (liked: boolean, likeCount: number) => ({
  feedback: [],
  summary: { like_count: likeCount, favorite_count: 0 },
  my_feedback: { liked },
});

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const photos = [
    { id: 1, filename: 'a.jpg', is_liked: false, like_count: 0 },
    { id: 2, filename: 'b.jpg', is_liked: false, like_count: 0 },
  ];
  queryClient.setQueryData(LIST_KEY, { photos } as unknown as GalleryData);
  const refetch = vi.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useFeedbackChange('summer', refetch), { wrapper });
  const rows = () => queryClient.getQueryData<GalleryData>(LIST_KEY)!.photos;
  return { queryClient, refetch, photos, rows, onFeedbackChange: result.current };
}

describe('useFeedbackChange', () => {
  beforeEach(() => { getPhotoFeedback.mockReset(); });

  it('patches only the liked photo and leaves the list request alone', async () => {
    getPhotoFeedback.mockResolvedValue(feedback(true, 3));
    const { refetch, photos, rows, onFeedbackChange } = setup();

    onFeedbackChange(2);

    await waitFor(() => expect(rows()[1]).toMatchObject({ is_liked: true, like_count: 3 }));
    expect(getPhotoFeedback).toHaveBeenCalledWith('summer', '2');
    expect(refetch).not.toHaveBeenCalled();
    // The untouched row keeps its identity, so its tile does not re-render.
    expect(rows()[0]).toBe(photos[0]);
  });

  it('refreshes my-feedback on every change', () => {
    getPhotoFeedback.mockResolvedValue(feedback(true, 1));
    const { queryClient, onFeedbackChange } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    onFeedbackChange(1);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-feedback', 'summer'] });
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: expect.arrayContaining(['gallery-photos']) }));
  });

  it('still refetches the list for a change that names no photo', () => {
    const { refetch, onFeedbackChange } = setup();

    onFeedbackChange();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(getPhotoFeedback).not.toHaveBeenCalled();
  });

  it('restarts a list request that is already out instead of patching under it', () => {
    const { queryClient, refetch, onFeedbackChange } = setup();
    vi.spyOn(queryClient, 'isFetching').mockReturnValue(1);

    onFeedbackChange(1);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(getPhotoFeedback).not.toHaveBeenCalled();
  });

  it('falls back to a list refetch when the per-photo request fails', async () => {
    getPhotoFeedback.mockRejectedValue(new Error('offline'));
    const { refetch, onFeedbackChange } = setup();

    onFeedbackChange(1);

    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it('lets only the last toggle on a photo write its row', async () => {
    let answerFirst: (value: unknown) => void = () => {};
    getPhotoFeedback
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValueOnce(feedback(false, 0));
    const { rows, onFeedbackChange } = setup();

    onFeedbackChange(1); // like
    onFeedbackChange(1); // unlike, answered first
    await waitFor(() => expect(getPhotoFeedback).toHaveBeenCalledTimes(2));
    answerFirst(feedback(true, 1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rows()[0]).toMatchObject({ is_liked: false, like_count: 0 });
  });

  // A like's answer is slow; meanwhile an unlike of the same photo ends in a
  // list refetch (a list request happened to be out). The slow answer must
  // not put the like back on top of that fresher list.
  it('drops an answer that a list fetch has overtaken', async () => {
    let answer: (value: unknown) => void = () => {};
    getPhotoFeedback.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { queryClient, rows, onFeedbackChange } = setup();

    onFeedbackChange(1);
    await waitFor(() => expect(getPhotoFeedback).toHaveBeenCalledTimes(1));
    // The refetched list arrives: the photo is not liked.
    await queryClient.fetchQuery({
      queryKey: LIST_KEY, staleTime: 0,
      queryFn: async () => ({ photos: [{ id: 1, filename: 'a.jpg', is_liked: false, like_count: 0 }] }) as unknown as GalleryData,
    });
    answer(feedback(true, 1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rows()[0]).toMatchObject({ is_liked: false, like_count: 0 });
  });

  it('does not write one guest\'s like into a list fetched for another', async () => {
    let answer: (value: unknown) => void = () => {};
    getPhotoFeedback.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { queryClient, onFeedbackChange } = setup();
    const otherGuest = ['gallery-photos', 'summer', 'all', 42];

    onFeedbackChange(1);
    await waitFor(() => expect(getPhotoFeedback).toHaveBeenCalledTimes(1));
    await queryClient.fetchQuery({
      queryKey: otherGuest,
      queryFn: async () => ({ photos: [{ id: 1, filename: 'a.jpg', is_liked: false, like_count: 0 }] }) as unknown as GalleryData,
    });
    answer(feedback(true, 1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData<GalleryData>(otherGuest)!.photos[0]).toMatchObject({ is_liked: false });
    expect(queryClient.getQueryData<GalleryData>(LIST_KEY)!.photos[0]).toMatchObject({ is_liked: true });
  });

  // A tile rating writes into the same cached lists. That is not a newer
  // snapshot of the list, and must not cost the like its only refresh.
  it('still applies an answer after another write to the cached list', async () => {
    let answer: (value: unknown) => void = () => {};
    getPhotoFeedback.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { queryClient, rows, onFeedbackChange } = setup();

    onFeedbackChange(1);
    await waitFor(() => expect(getPhotoFeedback).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 2));
    queryClient.setQueriesData<GalleryData>({ queryKey: ['gallery-photos', 'summer'] }, (old) =>
      (old ? { ...old, photos: old.photos.map((p) => (p.id === 2 ? { ...p, my_rating: 4 } : p)) } : old));
    answer(feedback(true, 1));

    await waitFor(() => expect(rows()[0]).toMatchObject({ is_liked: true, like_count: 1 }));
    expect(rows()[1]).toMatchObject({ my_rating: 4 });
  });

  it('applies the answers for two photos asked for at the same time', async () => {
    const answers: Array<(value: unknown) => void> = [];
    getPhotoFeedback.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const { rows, onFeedbackChange } = setup();

    onFeedbackChange(1);
    onFeedbackChange(2);
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[0](feedback(true, 1));
    await waitFor(() => expect(rows()[0]).toMatchObject({ is_liked: true }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    answers[1](feedback(true, 5));

    await waitFor(() => expect(rows()[1]).toMatchObject({ is_liked: true, like_count: 5 }));
  });

  // Leaving the gallery ends the bookkeeping that tells a stale answer from a
  // fresh one; an answer still on its way must not reach the next visit's list.
  it('drops an answer that arrives after the gallery was left', async () => {
    let answer: (value: unknown) => void = () => {};
    getPhotoFeedback.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(LIST_KEY, { photos: [{ id: 1, filename: 'a.jpg', is_liked: false, like_count: 0 }] } as unknown as GalleryData);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useFeedbackChange('summer', vi.fn()), { wrapper });

    result.current(1);
    await waitFor(() => expect(getPhotoFeedback).toHaveBeenCalledTimes(1));
    unmount();
    // The next visit fetched the list again: not liked (another guest, say).
    await queryClient.fetchQuery({
      queryKey: LIST_KEY, staleTime: 0,
      queryFn: async () => ({ photos: [{ id: 1, filename: 'a.jpg', is_liked: false, like_count: 0 }] }) as unknown as GalleryData,
    });
    answer(feedback(true, 1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData<GalleryData>(LIST_KEY)!.photos[0]).toMatchObject({ is_liked: false, like_count: 0 });
    expect(queryClient.getQueryState(LIST_KEY)!.isInvalidated).toBe(true);
  });

  // A tile's submit can finish after the gallery was left and still call the
  // handler it captured. That handler must not start a refresh of its own.
  it('does nothing when it is called after the gallery was left', async () => {
    getPhotoFeedback.mockResolvedValue(feedback(true, 1));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(LIST_KEY, { photos: [{ id: 1, filename: 'a.jpg', is_liked: false, like_count: 0 }] } as unknown as GalleryData);
    const refetch = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useFeedbackChange('summer', refetch), { wrapper });
    const captured = result.current;
    unmount();

    captured(1);
    captured();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getPhotoFeedback).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<GalleryData>(LIST_KEY)!.photos[0]).toMatchObject({ is_liked: false });
    // Not written, but not trusted either: the list is cached for minutes, so
    // it is marked stale and the next visit fetches it.
    expect(queryClient.getQueryState(LIST_KEY)!.isInvalidated).toBe(true);
  });

  // The guest left and is already back when the old visit's save completes:
  // the list on screen came from the cache and has to be fetched now.
  it('refetches a list that is on screen again when a previous visit\'s save completes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
    queryClient.setQueryData(LIST_KEY, { photos: [{ id: 1, filename: 'a.jpg', is_liked: false, like_count: 0 }] } as unknown as GalleryData);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const first = renderHook(() => useFeedbackChange('summer', vi.fn()), { wrapper });
    const captured = first.result.current;
    first.unmount();
    // Back in the gallery: its list is being shown from the cache.
    const listFetch = vi.fn().mockResolvedValue({ photos: [{ id: 1, filename: 'a.jpg', is_liked: true, like_count: 1 }] });
    renderHook(() => useQuery({ queryKey: LIST_KEY, queryFn: listFetch }), { wrapper });
    expect(listFetch).not.toHaveBeenCalled();

    captured(1);

    await waitFor(() => expect(listFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.getQueryData<GalleryData>(LIST_KEY)!.photos[0]).toMatchObject({ is_liked: true }));
    expect(getPhotoFeedback).not.toHaveBeenCalled();
  });

  // A PIN client's list carries the counts even when the gallery hides them
  // from guests; the per-photo answer does not, and would wipe them.
  it('refetches the list instead of patching when told not to patch', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refetch = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useFeedbackChange('summer', refetch, { patchRows: false }), { wrapper });

    result.current(1);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(getPhotoFeedback).not.toHaveBeenCalled();
  });
});
