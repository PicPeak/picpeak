import { useQuery, useQueryClient } from '@tanstack/react-query';
import { feedbackService, type FeedbackSettings } from '../services/feedback.service';

export const galleryFeedbackSettingsQueryKey = (slug: string) =>
  ['gallery-feedback-settings', slug] as const;

/** How long the lightbox and the feedback panel reuse the cached settings. */
export const FEEDBACK_SETTINGS_STALE_TIME = 5 * 60 * 1000;

/**
 * A gallery's public feedback settings, one cache entry per gallery for the
 * view, the lightbox and the feedback panel.
 *
 * A failed refetch keeps the settings already cached, so a blip while a
 * photo is open does not switch feedback off for the whole gallery. A first
 * request that fails reads as `{ feedback_enabled: false }`, with every other
 * field, `identity_mode` among them, absent: GalleryView relies on that to
 * treat the gallery as having no guest identity mode.
 */
export function useGalleryFeedbackSettings(
  slug: string,
  options: { enabled?: boolean; staleTime?: number } = {},
) {
  const queryClient = useQueryClient();
  const queryKey = galleryFeedbackSettingsQueryKey(slug);
  return useQuery({
    queryKey,
    queryFn: async (): Promise<Partial<FeedbackSettings>> => {
      try {
        return await feedbackService.getGalleryFeedbackSettings(slug);
      } catch (error) {
        console.error('Error fetching feedback settings:', error);
        return queryClient.getQueryData<Partial<FeedbackSettings>>(queryKey) ?? { feedback_enabled: false };
      }
    },
    enabled: options.enabled ?? true,
    staleTime: options.staleTime,
  });
}
