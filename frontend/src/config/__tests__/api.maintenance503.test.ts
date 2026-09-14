/**
 * Every non-admin 503 switched the whole app to the maintenance screen. The
 * public document pages answer 503 EMAIL_UNAVAILABLE when the verification
 * email cannot be sent, and that page has to stay up to show the message and
 * let the customer try again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { api, setMaintenanceModeCallback } from '../api';

const originalAdapter = api.defaults.adapter;

function answer(status: number, data: unknown) {
  const adapter: AxiosAdapter = async (config) => {
    throw new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_RESPONSE, config, {}, {
      status, statusText: '', headers: {}, config: config as InternalAxiosRequestConfig, data,
    });
  };
  api.defaults.adapter = adapter;
}

describe('api 503 handling', () => {
  afterEach(() => {
    api.defaults.adapter = originalAdapter;
  });

  it('leaves a failed verification email to the page that asked for it', async () => {
    const onMaintenance = vi.fn();
    setMaintenanceModeCallback(onMaintenance);
    answer(503, { error: 'The verification email could not be sent.', code: 'EMAIL_UNAVAILABLE' });

    await expect(api.post(`/public/contracts/${'a'.repeat(64)}/verification`)).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(onMaintenance).not.toHaveBeenCalled();
  });

  it('still switches to maintenance for a maintenance 503', async () => {
    const onMaintenance = vi.fn();
    setMaintenanceModeCallback(onMaintenance);
    answer(503, { error: 'Service Unavailable', maintenance: true });

    await expect(api.get('/public/settings')).rejects.toBeTruthy();
    expect(onMaintenance).toHaveBeenCalledWith(true);
  });
});
