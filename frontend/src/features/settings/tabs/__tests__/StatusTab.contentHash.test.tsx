/**
 * Content-hash backfill card (issue 2194): it never starts by itself, a
 * running job offers Pause, a paused one Resume, and unreadable originals
 * can be retried.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('../../../../config/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: () => '' }) }));
vi.mock('../../hooks/useStatusTab', () => ({ useStatusTab: () => ({ storageInfo: null, systemStatus: null }) }));
vi.mock('../../components/UpdateNotificationSettings', () => ({ UpdateNotificationSettings: () => null }));
vi.mock('../../../../components/admin/SettingsSaveBar', () => ({ SettingsSaveBar: () => null }));
import { api } from '../../../../config/api';
import { StatusTab } from '../StatusTab';

const STATUS = '/admin/photos/repair-content-hashes/status';
let hashStatus: Record<string, unknown>;

function open() {
  const noop = () => {};
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StatusTab
        isActive
        handleSaveSoftLimit={noop}
        handleSaveCapacityOverride={noop}
        saveSoftLimitMutation={{ isPending: false }}
        saveCapacityOverrideMutation={{ isPending: false }}
        softLimitGb=""
        setSoftLimitGb={noop}
        softLimitDirty={false}
        setSoftLimitDirty={noop}
        capacityOverrideGb=""
        setCapacityOverrideGb={noop}
        availableOverrideGb=""
        setAvailableOverrideGb={noop}
        overrideDirty={false}
        setOverrideDirty={noop}
      />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const idle = { total: 10, hashed: 4, pending: 6, unreadable: 0, isRunning: false, pausing: false, paused: false, lastResult: null };

describe('StatusTab: content-hash backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hashStatus = { ...idle };
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url === STATUS ? hashStatus : {} }));
    vi.mocked(api.post).mockResolvedValue({ data: {} });
  });

  it('says it reads every original, and starts only on the button', async () => {
    const user = open();
    expect(await screen.findByText('settings.contentHashBackfill.ioWarning')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /settings.contentHashBackfill.button/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/photos/repair-content-hashes', { retryUnreadable: false }));
  });

  it('offers Pause while running', async () => {
    hashStatus = { ...idle, isRunning: true };
    const user = open();
    await user.click(await screen.findByRole('button', { name: /settings.contentHashBackfill.pause$/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/photos/repair-content-hashes/pause'));
    expect(screen.queryByRole('button', { name: /settings.contentHashBackfill.button/ })).toBeNull();
  });

  it('offers Resume after a pause, and a retry of the unreadable originals', async () => {
    hashStatus = { ...idle, paused: true, unreadable: 2, lastResult: { hashed: 4, failed: 2, skipped: 0, paused: true } };
    const user = open();
    expect(await screen.findByText('settings.contentHashBackfill.resultPaused')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /settings.contentHashBackfill.resume/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/photos/repair-content-hashes', { retryUnreadable: false }));
    await user.click(screen.getByRole('button', { name: /settings.contentHashBackfill.retryUnreadable/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/photos/repair-content-hashes', { retryUnreadable: true }));
  });
});
