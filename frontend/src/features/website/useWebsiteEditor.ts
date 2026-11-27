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

/** The server document the local draft started from, and its revision. */
interface Base {
  document: WebsiteDocument;
  revision: number;
}

export const EDITOR_QUERY_KEY = ['website-editor'] as const;

const same = (a: WebsiteDocument | null, b: WebsiteDocument | null) => JSON.stringify(a) === JSON.stringify(b);

function isConflict(err: unknown): boolean {
  const response = (err as { response?: { status?: number; data?: { code?: string } } } | null)?.response;
  return response?.status === 409 || response?.data?.code === 'WEBSITE_REVISION_CONFLICT';
}

/**
 * The editor's draft of the website: the server's draft plus local edits,
 * an undo/redo history (client-side only), and the save, publish and discard
 * operations. Local edits are a page-level draft saved through the save bar
 * (UX.md › Saving); publishing is an action that saves first.
 *
 * The draft is paired with the revision it was based on, and that revision
 * is what a save sends: a refetch that brings a newer server draft is taken
 * over only while nothing is edited, so a stale draft can never be saved
 * over someone else's change; the server answers 409 instead and `conflict`
 * says so. Edits typed while a save runs are kept on top of what it stored.
 */
export function useWebsiteEditor() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: EDITOR_QUERY_KEY, queryFn: websiteService.getState });
  const server = query.data;
  const [draft, setDraft] = useState<WebsiteDocument | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [conflict, setConflict] = useState(false);
  const lastEdit = useRef<{ key: string; at: number } | null>(null);

  // The draft as of the latest edit, so several edits in one tick chain and
  // the history is written outside a state updater (StrictMode runs those twice).
  const draftRef = useRef<WebsiteDocument | null>(null);
  draftRef.current = draft;
  const baseRef = useRef<Base | null>(null);
  baseRef.current = base;

  const replaceDraft = useCallback((next: WebsiteDocument | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const replaceBase = useCallback((next: Base) => {
    baseRef.current = next;
    setBase(next);
  }, []);

  // A server state the draft is not based on yet: take it over while the
  // draft is clean, leave a dirty draft alone.
  useEffect(() => {
    if (!server) return;
    const current = baseRef.current;
    if (current && current.revision === server.draft.revision && same(current.document, server.document)) return;
    if (!current || same(draftRef.current, current.document)) {
      replaceBase({ document: server.document, revision: server.draft.revision });
      replaceDraft(server.document);
      // The history describes documents from before this one: undoing into
      // them and saving would overwrite whoever wrote this draft.
      setHistory({ past: [], future: [] });
      lastEdit.current = null;
    }
  }, [server, replaceBase, replaceDraft]);

  const isDirty = !!(draft && base && !same(draft, base.document));

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

  /**
   * Take a server answer to a save or publish of `sent`. The stored
   * (normalised) document becomes the base; the draft follows it unless it
   * was edited after `sent` went out, in which case those edits stay.
   */
  const adopt = useCallback((state: EditorState, sent: WebsiteDocument | null) => {
    replaceBase({ document: state.document, revision: state.draft.revision });
    if (!sent || same(draftRef.current, sent)) replaceDraft(state.document);
    queryClient.setQueryData(EDITOR_QUERY_KEY, state);
    setConflict(false);
  }, [queryClient, replaceBase, replaceDraft]);

  const onError = useCallback((err: unknown) => {
    if (isConflict(err)) setConflict(true);
  }, []);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const sent = draftRef.current;
      const from = baseRef.current;
      if (!sent || !from) throw new Error('Nothing to save');
      return { state: await websiteService.saveDraft(sent, from.revision), sent };
    },
    onSuccess: ({ state, sent }) => adopt(state, sent),
    onError,
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      const sent = draftRef.current;
      const from = baseRef.current;
      if (!sent || !from) throw new Error('Nothing to publish');
      let revision = from.revision;
      if (!same(sent, from.document)) {
        const saved = await websiteService.saveDraft(sent, from.revision);
        adopt(saved, sent);
        revision = saved.draft.revision;
      }
      return { state: await websiteService.publish(revision), sent };
    },
    onSuccess: ({ state, sent }) => adopt(state, sent),
    onError,
  });

  const discard = useCallback(() => {
    if (baseRef.current) replaceDraft(baseRef.current.document);
    setHistory({ past: [], future: [] });
    lastEdit.current = null;
  }, [replaceDraft]);

  /** After a conflict: drop the local draft and load what is stored now. */
  const reloadLatest = useCallback(async () => {
    const result = await query.refetch();
    if (!result.data) return;
    replaceBase({ document: result.data.document, revision: result.data.draft.revision });
    replaceDraft(result.data.document);
    setHistory({ past: [], future: [] });
    lastEdit.current = null;
    setConflict(false);
  }, [query, replaceBase, replaceDraft]);

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
    conflict,
    reloadLatest,
  };
}
