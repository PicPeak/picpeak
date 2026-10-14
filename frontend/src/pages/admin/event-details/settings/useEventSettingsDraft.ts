import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import type { Event, DownloadResolutionChoice } from '../../../../types';
import type { ThemeConfig } from '../../../../types/theme.types';
import { api } from '../../../../config/api';
import { eventsService } from '../../../../services/events.service';
import { feedbackService, type FeedbackSettings } from '../../../../services/feedback.service';
import { archiveInProgressError } from '../../../../utils/archiveErrors';
import {
  INHERIT,
  DraftValidationError,
  dirtySections,
  downloadsPayload,
  eventFieldsFromEvent,
  eventUpdatePayload,
  rebaseDraft,
  resetSection,
  sameValue,
  slideshowFromEvent,
  slideshowPayload,
  type DownloadsDraft,
  type EventSettingsDraft,
  type SettingsSectionKey,
} from './draft';

export interface DownloadResolutionsPayload {
  overrides: {
    download_standard_resolution: string | null;
    download_resolution_picker_enabled: boolean | null;
    download_allow_original: boolean | null;
  };
  globals: {
    standard_resolution: string;
    picker_enabled: boolean;
    allow_original: boolean;
    resolutions: DownloadResolutionChoice[];
  };
  effective: {
    standard: string;
    picker_enabled: boolean;
    allow_original: boolean;
    choices: DownloadResolutionChoice[];
  };
}

function downloadsFromPayload(data: DownloadResolutionsPayload | undefined): DownloadsDraft | null {
  if (!data) return null;
  const tri = (v: boolean | null | undefined) => (v === null || v === undefined ? INHERIT : String(v));
  return {
    standard: data.overrides.download_standard_resolution ?? INHERIT,
    picker: tri(data.overrides.download_resolution_picker_enabled),
    allowOriginal: tri(data.overrides.download_allow_original),
  };
}

type Slice = keyof EventSettingsDraft;

const SLICE_LABEL_SECTION: Record<Slice, SettingsSectionKey> = {
  event: 'general',
  feedback: 'guests',
  downloads: 'downloads',
  slideshow: 'slideshow',
};

/**
 * One draft for the whole Settings tab. Keeps the server state each slice was
 * loaded from; a refetch (after an instant action elsewhere on the page)
 * replaces the slices the admin has not touched and leaves edited ones alone.
 */
export function useEventSettingsDraft({
  event,
  feedbackSettings,
  branding,
}: {
  event: Event;
  feedbackSettings: FeedbackSettings | undefined;
  branding: ThemeConfig | null | undefined;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: downloadsData } = useQuery<DownloadResolutionsPayload>({
    queryKey: ['event-download-resolutions', event.id],
    queryFn: async () => (await api.get(`/admin/events/${event.id}/download-resolutions`)).data,
  });

  const serverState = useMemo<EventSettingsDraft>(() => ({
    event: eventFieldsFromEvent(event, branding),
    feedback: feedbackSettings ?? null,
    downloads: downloadsFromPayload(downloadsData),
    slideshow: slideshowFromEvent(event),
  }), [event, feedbackSettings, downloadsData, branding]);

  const [base, setBase] = useState<EventSettingsDraft>(serverState);
  const [draft, setDraft] = useState<EventSettingsDraft>(serverState);
  const baseRef = useRef(base);
  baseRef.current = base;

  // Follow the server. Per FIELD on the events row: a field the admin has not
  // touched takes the new server value, so a change made elsewhere (an
  // instant action, another admin, an import repointing the folder) is not
  // written back from a stale draft on the next save. The smaller slices
  // follow as a whole.
  useEffect(() => {
    const prevBase = baseRef.current;
    setDraft((current) => rebaseDraft(current, prevBase, serverState));
    setBase(serverState);
  }, [serverState]);

  const dirty = useMemo(() => dirtySections(draft, base), [draft, base]);
  const isDirty = dirty.size > 0;
  const [isSaving, setIsSaving] = useState(false);

  const discard = useCallback(() => setDraft(baseRef.current), []);
  const discardSection = useCallback(
    (section: SettingsSectionKey) => setDraft((d) => resetSection(d, baseRef.current, section)),
    [],
  );

  const setEvent = useCallback(
    (update: (prev: EventSettingsDraft['event']) => EventSettingsDraft['event']) =>
      setDraft((d) => ({ ...d, event: update(d.event) })),
    [],
  );

  const save = useCallback(async (): Promise<{ invalidSection?: SettingsSectionKey }> => {
    let payload: Record<string, unknown> | null;
    try {
      payload = eventUpdatePayload(draft.event, base.event, (key, fallback) => t(key, fallback));
    } catch (error) {
      if (error instanceof DraftValidationError) {
        toast.error(error.message);
        return { invalidSection: error.section };
      }
      throw error;
    }

    setIsSaving(true);
    const saved: Slice[] = [];
    const failed: Array<{ slice: Slice; message: string }> = [];
    const run = async (slice: Slice, request: () => Promise<unknown>) => {
      try {
        await request();
        saved.push(slice);
      } catch (error: unknown) {
        const e = error as { response?: { data?: { error?: string; errors?: Array<{ msg: string }> } } };
        failed.push({
          slice,
          message: archiveInProgressError(error, t)
            ?? (e.response?.data?.errors?.[0]?.msg || e.response?.data?.error || t('toast.saveError', 'Failed to save changes')),
        });
      }
    };

    if (payload) await run('event', () => eventsService.updateEvent(event.id, payload as never));
    if (draft.feedback && !sameValue(draft.feedback, base.feedback)) {
      const feedback = draft.feedback;
      await run('feedback', () => feedbackService.updateEventFeedbackSettings(String(event.id), feedback));
    }
    if (draft.downloads && !sameValue(draft.downloads, base.downloads)) {
      const downloads = draft.downloads;
      await run('downloads', () => api.patch(`/admin/events/${event.id}/download-resolutions`, downloadsPayload(downloads)));
    }
    if (draft.slideshow && !sameValue(draft.slideshow, base.slideshow)) {
      const slideshow = draft.slideshow;
      await run('slideshow', () => eventsService.updateSlideshowSettings(event.id, slideshowPayload(slideshow)));
    }

    // Saved slices become the new comparison point straight away (the
    // refetches below confirm them); the password is never kept in the draft.
    if (saved.length > 0) {
      const clearPassword = (d: EventSettingsDraft): EventSettingsDraft => (
        saved.includes('event')
          ? { ...d, event: { ...d.event, new_password: '', confirm_new_password: '' } }
          : d
      );
      setDraft((d) => clearPassword(d));
      setBase((b) => {
        const next = { ...b };
        saved.forEach((slice) => { (next as Record<Slice, unknown>)[slice] = clearPassword(draft)[slice]; });
        return next;
      });
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-event', String(event.id)] }),
      queryClient.invalidateQueries({ queryKey: ['admin-event-feedback-settings', String(event.id)] }),
      queryClient.invalidateQueries({ queryKey: ['event-download-resolutions', event.id] }),
      // Saving "partial" brings up the status card and "Full gallery is ready".
      queryClient.invalidateQueries({ queryKey: ['event-delivery', event.id] }),
      queryClient.invalidateQueries({ queryKey: ['admin-events'] }),
    ]);
    setIsSaving(false);

    if (failed.length === 0) {
      toast.success(t('toast.eventUpdated', 'Event updated successfully'));
    } else {
      for (const f of failed) toast.error(f.message);
      return { invalidSection: SLICE_LABEL_SECTION[failed[0].slice] };
    }
    return {};
  }, [draft, base, event.id, queryClient, t]);

  return {
    draft,
    setDraft,
    setEvent,
    dirty,
    isDirty,
    isSaving,
    save,
    discard,
    discardSection,
    downloadsData,
  };
}

export type EventSettingsDraftApi = ReturnType<typeof useEventSettingsDraft>;
