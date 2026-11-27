import { parseISO, isValid } from 'date-fns';

// Helper to safely parse dates that might be strings, Date objects, or timestamps
export const safeParseDate = (dateValue: unknown): Date | null => {
  if (!dateValue) {
    return null;
  }
  if (dateValue instanceof Date) {
    return dateValue;
  }
  if (typeof dateValue === 'number') {
    return new Date(dateValue);
  }
  if (typeof dateValue === 'string') {
    const parsed = parseISO(dateValue);
    return isValid(parsed) ? parsed : new Date(dateValue);
  }
  return null;
};

/**
 * Whether the event can have guest identities to manage: guest feedback
 * mode, or guest uploads with uploader names (#1561), which register a guest
 * whatever the feedback mode.
 */
export const eventHasGuests = (
  event: { allow_user_uploads?: boolean; guest_name_mode?: string } | undefined,
  feedbackSettings: { identity_mode?: string } | undefined,
): boolean => feedbackSettings?.identity_mode === 'guest'
  || (!!event?.allow_user_uploads && !!event?.guest_name_mode && event.guest_name_mode !== 'off');

/**
 * How often the event page re-reads its photo list: every 2s while an upload
 * is still being processed or a saved edit (issue 2619) is still being
 * applied, so the grid shows the new thumbnails even after the editor closed.
 * An edit whose render failed waits for a retry instead of being polled.
 */
export const photoListPollInterval = (
  photos: Array<{ processing_status?: string; edit_rev?: number; edit_applied_rev?: number; edit_failed?: boolean }> | undefined,
): number | false => {
  if (!Array.isArray(photos)) return false;
  const inFlight = photos.some((p) => p.processing_status === 'pending' || p.processing_status === 'processing'
    || ((p.edit_rev ?? 0) > (p.edit_applied_rev ?? 0) && !p.edit_failed));
  return inFlight ? 2000 : false;
};
