import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setMaintenanceModeCallback } from '../api';

type Handler = { rejected: (error: unknown) => Promise<unknown> };

function reject503(data: unknown) {
  const [handler] = (api.interceptors.response as unknown as { handlers: Handler[] }).handlers;
  return handler.rejected({ response: { status: 503, data }, config: { url: '/gallery/demo/upload' } }).catch(() => {});
}

describe('a 503 for one paused feature', () => {
  const maintenance = vi.fn();
  const notice = vi.fn();
  const listener = (event: Event) => notice((event as CustomEvent).detail);

  afterEach(() => {
    window.removeEventListener('picpeak:capability-unavailable', listener);
    setMaintenanceModeCallback(() => {});
    vi.clearAllMocks();
  });

  it('raises a notice and leaves the app on screen', async () => {
    setMaintenanceModeCallback(maintenance);
    window.addEventListener('picpeak:capability-unavailable', listener);
    await reject503({ code: 'CAPABILITY_UNAVAILABLE', capability: 'uploads.new' });
    expect(notice).toHaveBeenCalledWith('uploads.new');
    expect(maintenance).not.toHaveBeenCalled();
  });

  it('still treats a plain 503 as maintenance', async () => {
    setMaintenanceModeCallback(maintenance);
    await reject503({ error: 'down' });
    expect(maintenance).toHaveBeenCalledWith(true);
  });
});
