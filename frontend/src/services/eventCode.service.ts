import { api } from '../config/api';

/**
 * Public event-code lookup (issue 2495). Answers the gallery path the event's
 * share link opens; every miss is the same 404.
 */
export const eventCodeService = {
  async lookup(code: string): Promise<{ path: string }> {
    const response = await api.get<{ path: string }>(`/public/event-code/${encodeURIComponent(code)}`);
    return response.data;
  },
};
