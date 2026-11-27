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

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useWebsiteEditor(), { wrapper });
}

describe('useWebsiteEditor', () => {
  beforeEach(() => {
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
});
