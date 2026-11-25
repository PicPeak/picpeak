import { useQuery } from '@tanstack/react-query';
import { feedbackService, type FeedbackSettings } from '../services/feedback.service';

export const galleryFeedbackSettingsQueryKey = (slug: string) =>
  ['gallery-feedback-settings', slug] as const;

/**
 * A gallery's public feedback settings, one cache entry per gallery for the
 * view, the lightbox and the feedback panel.
 *
 * A failed request reads as `{ feedback_enabled: false }`, with every other
 * field, `identity_mode` among them, absent: GalleryView relies on that to
 * treat the gallery as having no guest identity mode.
 */
export function useGalleryFeedbackSettings(
  slug: string,
  options: { enabled?: boolean; staleTime?: number } = {},
) {
  return useQuery({
    queryKey: galleryFeedbackSettingsQueryKey(slug),
    queryFn: async (): Promise<Partial<FeedbackSettings>> => {
      try {
        return await feedbackService.getGalleryFeedbackSettings(slug);
      } catch (error) {
        console.error('Error fetching feedback settings:', error);
        return { feedback_enabled: false };
      }
    },
    enabled: options.enabled ?? true,
    staleTime: options.staleTime,
  });
}
