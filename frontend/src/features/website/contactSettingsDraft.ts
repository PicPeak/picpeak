/**
 * The contact form settings' draft (issue 2618), held by the builder page so
 * switching panels never drops it (UX.md: the draft at page level). It is
 * saved through the builder's save bar, on its own request: these settings
 * apply as soon as they are saved, not with the website's draft.
 *
 * The same discipline as the website's draft: the draft is compared with the
 * settings it was taken from (the accepted baseline); a refetch fills in only
 * the fields the admin has not edited, then becomes the baseline; a save
 * keeps what was typed while it ran; and a save names the revision it was
 * made from, so a stale view is refused (409) instead of overwriting a
 * colleague's newer settings, with a way to load the latest.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermission } from '../../hooks/usePermission';
import { websiteService, type CaptchaProvider, type ContactSettings, type ContactSettingsUpdate } from '../../services/website.service';

export const CONTACT_SETTINGS_KEY = ['website-contact-settings'];

interface ContactDraft {
  provider: CaptchaProvider;
  siteKey: string;
  endpoint: 'global' | 'eu';
  /** '' = keep the saved key. */
  apiKey: string;
  /** As typed: addresses separated by commas. */
  recipients: string;
  confirmation: boolean;
}
type Field = keyof ContactDraft;
const FIELDS: Field[] = ['provider', 'siteKey', 'endpoint', 'apiKey', 'recipients', 'confirmation'];

function fromServer(data: ContactSettings): ContactDraft {
  return {
    provider: data.captcha.provider,
    siteKey: data.captcha.friendly.siteKey,
    endpoint: data.captcha.friendly.endpoint,
    apiKey: '',
    recipients: data.contact.recipients.join(', '),
    confirmation: data.contact.confirmation,
  };
}

/** Each field of `draft` that still equals `was` takes its value from `next`. */
function takeUntouched(draft: ContactDraft, was: ContactDraft, next: ContactDraft): ContactDraft {
  const out = { ...draft };
  FIELDS.forEach((f) => { if (draft[f] === was[f]) (out as Record<Field, unknown>)[f] = next[f]; });
  return out;
}

const recipientList = (text: string) => text.split(/[\s,;]+/).filter(Boolean);
const isConflict = (err: unknown) => (err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'WEBSITE_CONTACT_CONFLICT';

export function useContactSettingsDraft() {
  const queryClient = useQueryClient();
  const canChange = usePermission('settings.edit');
  const query = useQuery({ queryKey: CONTACT_SETTINGS_KEY, queryFn: websiteService.getContactSettings });
  const server = query.data;
  // held: a refetch clashed with an edit; the revision stays the edit's own.
  const [state, setState] = useState<{ draft: ContactDraft; accepted: ContactDraft; revision: number; held?: boolean } | null>(null);
  const [conflict, setConflict] = useState(false);
  // The server value the draft already took in (a save's answer is taken in
  // by the save itself, field by field).
  const adopted = useRef<ContactSettings | undefined>(undefined);

  useEffect(() => {
    if (!server || adopted.current === server) return;
    adopted.current = server;
    const next = fromServer(server);
    setState((s) => {
      if (!s) return { draft: next, accepted: next, revision: server.revision };
      // A read that started before a save and answered after it: older than
      // what the draft already took in, so not taken.
      if (server.revision < s.revision) return s;
      // A setting this admin edited that someone else changed meanwhile: the
      // draft keeps the revision the edit was made from, so its save is
      // refused (409) instead of overwriting the colleague's value, and the
      // conflict shows now. Otherwise the newer revision is taken in.
      // Once held, it stays held until the latest is loaded or a save answers.
      const clash = s.held || FIELDS.some((f) => s.draft[f] !== s.accepted[f] && next[f] !== s.accepted[f] && s.draft[f] !== next[f]);
      if (clash) setConflict(true);
      return { draft: takeUntouched(s.draft, s.accepted, next), accepted: next, revision: clash ? s.revision : server.revision, held: clash };
    });
  }, [server]);

  const draft = state?.draft ?? null;
  const dirty = !!state && FIELDS.some((f) => state.draft[f] !== state.accepted[f]);

  const mutation = useMutation({
    mutationFn: (body: ContactSettingsUpdate) => websiteService.saveContactSettings(body),
  });

  const save = async () => {
    if (!state) return undefined;
    const sent = state.draft;
    try {
      const saved = await mutation.mutateAsync({
        revision: state.revision,
        captcha: {
          provider: sent.provider,
          friendly: { siteKey: sent.siteKey.trim(), endpoint: sent.endpoint, ...(sent.apiKey.trim() ? { apiKey: sent.apiKey.trim() } : {}) },
        },
        contact: { recipients: recipientList(sent.recipients), confirmation: sent.confirmation && sent.provider !== 'none' },
      });
      const next = fromServer(saved);
      // A read still under way would answer with the settings before this save.
      await queryClient.cancelQueries({ queryKey: CONTACT_SETTINGS_KEY });
      adopted.current = saved;
      // Fields still as sent take the saved value; what was typed meanwhile stays.
      setState((s) => (s ? { draft: takeUntouched(s.draft, sent, next), accepted: next, revision: saved.revision } : s));
      queryClient.setQueryData(CONTACT_SETTINGS_KEY, saved);
      // The preview's and the live pages' forms change with it.
      void queryClient.invalidateQueries({ queryKey: ['website-preview'] });
      return saved;
    } catch (err) {
      if (isConflict(err)) setConflict(true);
      throw err;
    }
  };

  /** After a conflict: the latest settings, the stale edits dropped. */
  const loadLatest = async () => {
    const latest = await queryClient.fetchQuery({ queryKey: CONTACT_SETTINGS_KEY, queryFn: websiteService.getContactSettings, staleTime: 0 });
    adopted.current = latest;
    const next = fromServer(latest);
    setState({ draft: next, accepted: next, revision: latest.revision });
    setConflict(false);
  };

  return {
    server,
    draft,
    dirty,
    canChange,
    conflict,
    isSaving: mutation.isPending,
    set: (patch: Partial<ContactDraft>) => setState((s) => (s ? { ...s, draft: { ...s.draft, ...patch } } : s)),
    discard: () => setState((s) => (s ? { ...s, draft: s.accepted } : s)),
    save,
    loadLatest,
  };
}

export type ContactSettingsDraft = ReturnType<typeof useContactSettingsDraft>;
