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
