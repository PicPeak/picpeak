/**
 * Fired on window after a guest's feedback was stored (issue 1733). The
 * "x selected" counter listens: it reads /my-feedback, and not every layout
 * and name dialog reports a like to the gallery on its own.
 */
export const FEEDBACK_SUBMITTED_EVENT = 'picpeak:feedback-submitted';

/**
 * Fired on window after the viewer took back all their likes at once (issue
 * 2561). Tiles holding a just-clicked like drop that hold, so the cleared
 * state from the refresh that follows shows instead of the click.
 */
export const LIKES_CLEARED_EVENT = 'picpeak:likes-cleared';

export interface FeedbackSubmittedDetail {
  slug: string;
  feedback_type: string;
  /**
   * The name and email the request carried, when it carried both (simple and
   * shared mode). The hand-over bar takes them, so a visitor already named on
   * a like or comment is not asked again (issue 1984).
   */
  guest_name?: string;
  guest_email?: string;
}

/**
 * The name and email for the event detail, only when a request carried both.
 * Blank does not count: while optional, the server takes a whitespace-only
 * email with feedback but refuses it with a hand-over.
 */
export function namedIdentity(body?: { guest_name?: string; guest_email?: string }) {
  return body?.guest_name?.trim() && body.guest_email?.trim()
    ? { guest_name: body.guest_name, guest_email: body.guest_email }
    : {};
}
