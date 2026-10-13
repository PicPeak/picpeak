/**
 * Fired on window after a guest's feedback was stored (issue 1733). The
 * "x selected" counter listens: it reads /my-feedback, and not every layout
 * and name dialog reports a like to the gallery on its own.
 */
export const FEEDBACK_SUBMITTED_EVENT = 'picpeak:feedback-submitted';

export interface FeedbackSubmittedDetail {
  slug: string;
  feedback_type: string;
}
