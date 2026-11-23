import type { BadgeTone } from '../components/common';

/** Badge tone per quote status (quote page and the project's documents card). */
export const QUOTE_STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'neutral', sent: 'info', expired: 'warning', accepted: 'success', declined: 'danger', converted: 'success',
};
