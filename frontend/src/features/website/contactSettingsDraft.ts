/**
 * The contact form settings' draft (issue 2618), held by the builder page so
 * switching panels never drops it (UX.md: the draft at page level). It is
 * saved through the builder's save bar, on its own request: these settings
 * apply as soon as they are saved, not with the website's draft. Only what
 * changed is sent; the API key only when one was typed.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermission } from '../../hooks/usePermission';
import { websiteService, type CaptchaProvider, type ContactSettings, type ContactSettingsUpdate } from '../../services/website.service';

export const CONTACT_SETTINGS_KEY = ['website-contact-settings'];

export interface ContactDraft {
  provider: CaptchaProvider;
  siteKey: string;
  endpoint: 'global' | 'eu';
  /** '' = keep the saved key. */
  apiKey: string;
  /** As typed: addresses separated by commas. */
  recipients: string;
  confirmation: boolean;
}

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

const recipientList = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

export function useContactSettingsDraft() {
  const queryClient = useQueryClient();
  const canChange = usePermission('settings.edit');
  const query = useQuery({ queryKey: CONTACT_SETTINGS_KEY, queryFn: websiteService.getContactSettings });
  const server = query.data;
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const base = useMemo(() => (server ? fromServer(server) : null), [server]);

  const dirty = !!(draft && base) && (
    draft.provider !== base.provider || draft.siteKey.trim() !== base.siteKey || draft.endpoint !== base.endpoint
    || draft.apiKey.trim() !== '' || draft.recipients.trim() !== base.recipients.trim()
    || (draft.confirmation && draft.provider !== 'none') !== base.confirmation
  );
  // A clean draft follows the server (a save, a refetch).
  useEffect(() => {
    if (base && !dirty) setDraft(base);
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutation = useMutation({
    mutationFn: (body: ContactSettingsUpdate) => websiteService.saveContactSettings(body),
    onSuccess: (next) => {
      queryClient.setQueryData(CONTACT_SETTINGS_KEY, next);
      setDraft(fromServer(next));
      // The preview's and the live pages' forms change with it.
      void queryClient.invalidateQueries({ queryKey: ['website-preview'] });
    },
  });

  const save = () => {
    if (!draft) return Promise.resolve(undefined);
    return mutation.mutateAsync({
      captcha: {
        provider: draft.provider,
        friendly: { siteKey: draft.siteKey.trim(), endpoint: draft.endpoint, ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}) },
      },
      contact: { recipients: recipientList(draft.recipients), confirmation: draft.confirmation && draft.provider !== 'none' },
    });
  };

  return {
    server,
    draft,
    dirty,
    canChange,
    isSaving: mutation.isPending,
    set: (patch: Partial<ContactDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    discard: () => { if (base) setDraft(base); },
    save,
  };
}

export type ContactSettingsDraft = ReturnType<typeof useContactSettingsDraft>;
