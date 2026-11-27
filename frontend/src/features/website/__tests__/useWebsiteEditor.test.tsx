import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EditorState, WebsiteDocument } from '../types';

vi.mock('../../../services/website.service', () => ({
  websiteService: { getState: vi.fn(), saveDraft: vi.fn(), publish: vi.fn() },
  mediaKey: (r: { source: string; id: string | number }) => `${r.source}:${r.id}`,
}));

import { websiteService } from '../../../services/website.service';
import { useWebsiteEditor } from '../useWebsiteEditor';

const doc = (title: string): WebsiteDocument => ({
  version: 1,
  pages: [{ id: 'home', slug: 'home', title, navLabel: '', hidden: false, inNav: true, isHome: true, seo: { title: '', description: '', image: null }, blocks: [] }],
  theme: { headingFont: null, bodyFont: null, buttonStyle: null, accent: null, background: null, text: null },
  customCss: '',
});
const state = (title: string, revision = 1, extra: Partial<EditorState> = {}): EditorState => ({
  document: doc(title), draft: { revision, updatedAt: '', publishedAt: null }, published: null,
  hasUnpublishedChanges: true, publicSiteEnabled: true, ...extra,
});
const rename = (title: string) => (d: WebsiteDocument) => ({ ...d, pages: [{ ...d.pages[0], title }] });

let client: QueryClient;
function setup() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useWebsiteEditor(), { wrapper });
}

describe('useWebsiteEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(websiteService.getState).mockResolvedValue(state('Home'));
  });

  it('starts from the server draft and tracks unsaved edits', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draft?.pages[0].title).toBe('Home'));
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.update(rename('Start')));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.update(rename('Home')));
    expect(result.current.isDirty).toBe(false);
  });

  it('undoes and redoes, and typing in one field is one step', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('H'), 'title'));
    act(() => result.current.update(rename('He'), 'title'));
    act(() => result.current.update(rename('Hel'), 'title'));
    act(() => result.current.update(rename('Other')));
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.draft?.pages[0].title).toBe('Hel');
    act(() => result.current.undo());
    expect(result.current.draft?.pages[0].title).toBe('Home');
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.redo());
    expect(result.current.draft?.pages[0].title).toBe('Hel');
    // A new edit drops the redo branch.
    act(() => result.current.update(rename('New')));
    expect(result.current.canRedo).toBe(false);
  });

  it('saves with the revision it read and adopts what the server stored', async () => {
    vi.mocked(websiteService.saveDraft).mockResolvedValue(state('Stored', 2));
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('Typed')));
    await act(async () => { await result.current.save.mutateAsync(); });
    expect(websiteService.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ pages: [expect.objectContaining({ title: 'Typed' })] }), 1);
    expect(result.current.draft?.pages[0].title).toBe('Stored');
    expect(result.current.isDirty).toBe(false);
  });

  it('publishing saves a dirty draft first, then publishes that revision', async () => {
    vi.mocked(websiteService.saveDraft).mockResolvedValue(state('Typed', 5));
    vi.mocked(websiteService.publish).mockResolvedValue(state('Typed', 5, { hasUnpublishedChanges: false }));
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('Typed')));
    await act(async () => { await result.current.publish.mutateAsync(); });
    expect(websiteService.publish).toHaveBeenCalledWith(5);
    expect(result.current.server?.hasUnpublishedChanges).toBe(false);
  });

  it('discard returns to the server draft and clears the history', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('Changed')));
    act(() => result.current.discard());
    expect(result.current.draft?.pages[0].title).toBe('Home');
    expect(result.current.canUndo).toBe(false);
  });

  it('keeps a dirty draft on a refetch and saves it against the revision it was based on', async () => {
    vi.mocked(websiteService.saveDraft).mockRejectedValue({ response: { status: 409, data: { code: 'WEBSITE_REVISION_CONFLICT' } } });
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('Mine')));
    // Someone else saved meanwhile; a refetch brings revision 2.
    act(() => { client.setQueryData(['website-editor'], state('Theirs', 2)); });
    expect(result.current.draft?.pages[0].title).toBe('Mine');
    await act(async () => { await result.current.save.mutateAsync().catch(() => {}); });
    expect(websiteService.saveDraft).toHaveBeenLastCalledWith(expect.anything(), 1);
    expect(result.current.conflict).toBe(true);
    expect(result.current.draft?.pages[0].title).toBe('Mine');
    vi.mocked(websiteService.getState).mockResolvedValue(state('Theirs', 2));
    await act(async () => { await result.current.reloadLatest(); });
    expect(result.current.draft?.pages[0].title).toBe('Theirs');
    expect(result.current.conflict).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });

  it('keeps the draft and its undo when loading the latest version fails or brings nothing newer', async () => {
    vi.mocked(websiteService.saveDraft).mockRejectedValue({ response: { status: 409, data: { code: 'WEBSITE_REVISION_CONFLICT' } } });
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('Mine')));
    await act(async () => { await result.current.save.mutateAsync().catch(() => {}); });
    expect(result.current.conflict).toBe(true);

    vi.mocked(websiteService.getState).mockRejectedValue(new Error('Network down'));
    await act(async () => { await result.current.reloadLatest(); });
    // The page shows the failed load from the query's error state.
    expect(client.getQueryState(['website-editor'])?.status).toBe('error');
    expect(result.current.draft?.pages[0].title).toBe('Mine');
    expect(result.current.canUndo).toBe(true);
    expect(result.current.conflict).toBe(true);

    // Answered, but with the revision this draft is already based on.
    vi.mocked(websiteService.getState).mockResolvedValue(state('Home', 1));
    await act(async () => { await result.current.reloadLatest(); });
    expect(result.current.draft?.pages[0].title).toBe('Mine');
    expect(result.current.canUndo).toBe(true);
    expect(result.current.conflict).toBe(true);
  });

  it('takes over a refetched draft while nothing is edited', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => { client.setQueryData(['website-editor'], state('Theirs', 2)); });
    await waitFor(() => expect(result.current.draft?.pages[0].title).toBe('Theirs'));
    vi.mocked(websiteService.saveDraft).mockResolvedValue(state('Next', 3));
    act(() => result.current.update(rename('Next')));
    await act(async () => { await result.current.save.mutateAsync(); });
    expect(websiteService.saveDraft).toHaveBeenLastCalledWith(expect.anything(), 2);
  });

  it('keeps what was typed while a save was on its way', async () => {
    let finish: (value: EditorState) => void = () => {};
    vi.mocked(websiteService.saveDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('First')));
    let saving: Promise<unknown> = Promise.resolve();
    act(() => { saving = result.current.save.mutateAsync(); });
    await waitFor(() => expect(websiteService.saveDraft).toHaveBeenCalled());
    act(() => result.current.update(rename('First and more')));
    await act(async () => { finish(state('First', 2)); await saving; });
    expect(result.current.draft?.pages[0].title).toBe('First and more');
    expect(result.current.isDirty).toBe(true);
    // The next save goes out against the revision the first one stored.
    vi.mocked(websiteService.saveDraft).mockResolvedValue(state('First and more', 3));
    await act(async () => { await result.current.save.mutateAsync(); });
    expect(websiteService.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ pages: [expect.objectContaining({ title: 'First and more' })] }), 2);
    expect(result.current.isDirty).toBe(false);
  });

  it('forgets the undo history when it takes over a colleague\'s draft', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('Mine')));
    act(() => result.current.update(rename('Home')));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.isDirty).toBe(false);
    // Clean, so a refetch with a colleague's draft is taken over.
    act(() => { client.setQueryData(['website-editor'], state('Theirs', 2)); });
    await waitFor(() => expect(result.current.draft?.pages[0].title).toBe('Theirs'));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.draft?.pages[0].title).toBe('Theirs');
  });

  it('never lets a refetch that started before a save take the draft back to an older revision', async () => {
    vi.mocked(websiteService.saveDraft).mockResolvedValue(state('Saved', 2));
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.update(rename('Saved')));
    await act(async () => { await result.current.save.mutateAsync(); });
    act(() => result.current.update(rename('Saved, then more')));
    act(() => result.current.update(rename('Saved')));
    expect(result.current.canUndo).toBe(true);
    // A background fetch from before the save lands now, with revision 1.
    act(() => { client.setQueryData(['website-editor'], state('Home', 1)); });
    await waitFor(() => expect(result.current.server?.draft.revision).toBe(1));
    expect(result.current.draft?.pages[0].title).toBe('Saved');
    expect(result.current.canUndo).toBe(true);
    vi.mocked(websiteService.saveDraft).mockResolvedValue(state('Next', 3));
    act(() => result.current.update(rename('Next')));
    await act(async () => { await result.current.save.mutateAsync(); });
    expect(websiteService.saveDraft).toHaveBeenLastCalledWith(expect.anything(), 2);
  });

  it('cancels an editor fetch in flight when a save answers', async () => {
    vi.mocked(websiteService.saveDraft).mockResolvedValue(state('Saved', 2));
    const { result } = setup();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    const cancel = vi.spyOn(client, 'cancelQueries');
    act(() => result.current.update(rename('Saved')));
    await act(async () => { await result.current.save.mutateAsync(); });
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['website-editor'] });
  });
});

