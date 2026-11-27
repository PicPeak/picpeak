import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { websiteService } from '../../services/website.service';
import type { EditorState, WebsiteDocument } from './types';

const HISTORY_LIMIT = 100;
// Keystrokes in one field within this window are one undo step.
const COALESCE_MS = 800;

interface History {
  past: WebsiteDocument[];
  future: WebsiteDocument[];
}

export const EDITOR_QUERY_KEY = ['website-editor'] as const;

/**
 * The editor's draft of the website: the server's draft plus local edits,
 * an undo/redo history (client-side only), and the save, publish and discard
 * operations. Local edits are a page-level draft saved through the save bar
 * (UX.md › Saving); publishing is an action that saves first.
 */
export function useWebsiteEditor() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: EDITOR_QUERY_KEY, queryFn: websiteService.getState });
  const server = query.data;
  const [draft, setDraft] = useState<WebsiteDocument | null>(null);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const lastEdit = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (server && draft === null) setDraft(server.document);
  }, [server, draft]);

  const isDirty = !!(draft && server && JSON.stringify(draft) !== JSON.stringify(server.document));

  /**
   * Apply an edit. `coalesceKey` names the field being typed into, so a word
   * typed is one undo step rather than one per letter.
   */
  // The draft as of the latest edit, so several edits in one tick chain and
  // the history is written outside a state updater (StrictMode runs those twice).
  const draftRef = useRef<WebsiteDocument | null>(null);
  draftRef.current = draft;

  const replaceDraft = useCallback((next: WebsiteDocument | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /**
   * Apply an edit. `coalesceKey` names the field being typed into, so a word
   * typed is one undo step rather than one per letter.
   */
  const update = useCallback((fn: (doc: WebsiteDocument) => WebsiteDocument, coalesceKey?: string) => {
    const current = draftRef.current;
    if (!current) return;
    const next = fn(current);
    if (next === current) return;
    const now = Date.now();
    const coalesce = !!coalesceKey && lastEdit.current?.key === coalesceKey && now - lastEdit.current.at < COALESCE_MS;
    lastEdit.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    if (!coalesce) setHistory((h) => ({ past: [...h.past, current].slice(-HISTORY_LIMIT), future: [] }));
    replaceDraft(next);
  }, [replaceDraft]);

  const undo = useCallback(() => {
    const current = draftRef.current;
    if (!history.past.length || !current) return;
    lastEdit.current = null;
    setHistory({ past: history.past.slice(0, -1), future: [current, ...history.future] });
    replaceDraft(history.past[history.past.length - 1]);
  }, [history, replaceDraft]);

  const redo = useCallback(() => {
    const current = draftRef.current;
    if (!history.future.length || !current) return;
    lastEdit.current = null;
    const [next, ...rest] = history.future;
    setHistory({ past: [...history.past, current], future: rest });
    replaceDraft(next);
  }, [history, replaceDraft]);

  const adopt = useCallback((state: EditorState) => {
    queryClient.setQueryData(EDITOR_QUERY_KEY, state);
    // The server returns the stored (normalised) document; taking it keeps
    // the comparison honest and picks up ids it filled in.
    replaceDraft(state.document);
  }, [queryClient, replaceDraft]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft || !server) throw new Error('Nothing to save');
      return websiteService.saveDraft(draft, server.draft.revision);
    },
    onSuccess: adopt,
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!draft || !server) throw new Error('Nothing to publish');
      const saved = isDirty ? await websiteService.saveDraft(draft, server.draft.revision) : server;
      if (isDirty) adopt(saved);
      return websiteService.publish(saved.draft.revision);
    },
    onSuccess: adopt,
  });

  const discard = useCallback(() => {
    if (server) replaceDraft(server.document);
    setHistory({ past: [], future: [] });
    lastEdit.current = null;
  }, [server, replaceDraft]);

  return {
    query,
    server,
    draft,
    isDirty,
    update,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    save: saveMutation,
    publish: publishMutation,
    discard,
  };
}
