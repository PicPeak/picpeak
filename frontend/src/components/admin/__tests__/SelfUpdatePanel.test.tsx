/**
 * The one-click update panel (docs/self-update.md). It must stay invisible on
 * every install that has not opted in, and once this browser has started an
 * update it must follow it through the backend restart to a result.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SelfUpdatePanel, ManualUpdateSteps, useSelfUpdateActive } from '../SelfUpdatePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const getStatus = vi.fn();
const requestUpdate = vi.fn();
const withdrawRequest = vi.fn();
vi.mock('../../../services/selfUpdate.service', () => ({
  selfUpdateService: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    requestUpdate: (...args: unknown[]) => requestUpdate(...args),
    withdrawRequest: (...args: unknown[]) => withdrawRequest(...args),
  },
}));

// Recent, with milliseconds, as the backend writes it. The updater writes whole
// seconds, so its run in the same second reads as SAME_SECOND. The second
// before the current one: the panel only judges a request lost on a status
// fetched after it (dataUpdatedAt > requestedAt), and a STARTED up to 250 ms
// in the future let a fast refetch land "before" the request, leaving the
// result to the next poll 2 s later, past findBy's timeout.
const nowSecond = Math.floor(Date.now() / 1000) * 1000 - 1000;
const STARTED = new Date(nowSecond + 250).toISOString();
const SAME_SECOND = new Date(nowSecond).toISOString().replace('.000Z', 'Z');
const LATER = new Date(nowSecond + 5000).toISOString().replace('.000Z', 'Z');

function status(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    available: true,
    reason: null,
    contract: 1,
    agent: { contract: 1, state: 'idle', started_at: null },
    job: null,
    currentVersion: '3.159.0',
    can_request: true,
    request_block: null,
    ...over,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SelfUpdatePanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getStatus.mockReset();
  requestUpdate.mockReset();
  withdrawRequest.mockReset();
  window.sessionStorage.clear();
});

describe('SelfUpdatePanel', () => {
  it('renders nothing when in-app updates are off', async () => {
    getStatus.mockResolvedValue(status({ enabled: false, available: false, reason: 'disabled', agent: null }));
    const { container } = renderPanel();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('explains a missing updater instead of offering the button', async () => {
    getStatus.mockResolvedValue(status({ available: false, reason: 'no_agent', agent: null }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.noAgent')).toBeInTheDocument();
    expect(screen.queryByText('admin.updates.selfUpdate.submit')).not.toBeInTheDocument();
  });

  it('offers the button only to a super admin', async () => {
    getStatus.mockResolvedValue(status({ can_request: false }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.onlySuperAdmin')).toBeInTheDocument();
    expect(screen.queryByText('admin.updates.selfUpdate.submit')).not.toBeInTheDocument();
  });

  it('needs the password before it requests the update', async () => {
    getStatus.mockResolvedValue(status());
    requestUpdate.mockResolvedValue({ id: 'j1', phase: 'backing_up', started_at: STARTED, requested_by: 'me', backup: null, error: null });
    renderPanel();
    const button = await screen.findByRole('button', { name: 'admin.updates.selfUpdate.submit' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('admin.updates.selfUpdate.password'), { target: { value: 'secret' } });
    getStatus.mockResolvedValue(status({
      available: false, reason: 'busy',
      job: { id: 'j1', phase: 'backing_up', started_at: STARTED, requested_by: 'me', backup: null, error: null },
    }));
    fireEvent.click(button);

    await waitFor(() => expect(requestUpdate).toHaveBeenCalledWith('secret'));
    expect(await screen.findByText('admin.updates.selfUpdate.phase.backingUp')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('picpeak.selfUpdate.requestedAt')).toBe(STARTED);
  });

  it('maps a wrong password to its own message', async () => {
    getStatus.mockResolvedValue(status());
    requestUpdate.mockRejectedValue({ response: { status: 400, data: { code: 'SELF_UPDATE_BAD_PASSWORD' } } });
    renderPanel();
    fireEvent.change(await screen.findByLabelText('admin.updates.selfUpdate.password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'admin.updates.selfUpdate.submit' }));
    expect(await screen.findByText('admin.updates.selfUpdate.error.badPassword')).toBeInTheDocument();
  });

  it('keeps showing progress while the backend is down for the restart', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    getStatus.mockRejectedValue(new Error('502'));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.phase.restarting')).toBeInTheDocument();
  });

  it("shows the updater's step for the run it started, not an older one", async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    // A run from before this request, while the request is still pending
    // (the server reports that as busy): still waiting.
    getStatus.mockResolvedValue(status({
      available: false, reason: 'busy',
      agent: { contract: 1, state: 'succeeded', started_at: '2026-10-01T09:00:00Z', message: 'old run' },
    }));
    const { unmount } = renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.phase.waiting')).toBeInTheDocument();
    expect(screen.queryByText('old run')).not.toBeInTheDocument();
    unmount();

    // The updater writes whole seconds; its run starts in the same second.
    getStatus.mockResolvedValue(status({
      agent: { contract: 1, state: 'running', step: 'pull', started_at: SAME_SECOND },
    }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.step.pull')).toBeInTheDocument();
  });

  it('ends on the result with the reason the updater gave', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    getStatus.mockResolvedValue(status({
      agent: {
        contract: 1, state: 'rolled_back', started_at: LATER,
        message: 'PicPeak 3.160.0 did not start (backend is unhealthy), so 3.159.0 was brought back.',
      },
    }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.result.rolledBack')).toBeInTheDocument();
    expect(screen.getByText(/backend is unhealthy/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(window.sessionStorage.getItem('picpeak.selfUpdate.requestedAt')).toBeNull();
  });

  it('reports a failed backup and that nothing was requested', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    getStatus.mockResolvedValue(status({
      job: { id: 'j1', phase: 'backup_failed', started_at: STARTED, requested_by: 'me', backup: null, error: 'disk full' },
    }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.result.backupFailed')).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('folds the manual steps (and their backup checklist) away only while one-click applies', () => {
    const { container, rerender } = render(
      <ManualUpdateSteps active={false}><p>I have backed up my database</p></ManualUpdateSteps>,
    );
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText('I have backed up my database')).toBeVisible();

    rerender(<ManualUpdateSteps active><p>I have backed up my database</p></ManualUpdateSteps>);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(screen.getByText('admin.updates.selfUpdate.manualInstead')).toBeInTheDocument();
  });

  it('forgets a remembered request once in-app updates are off', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    getStatus.mockResolvedValue(status({ enabled: false, available: false, reason: 'disabled', agent: null }));
    const { container } = renderPanel();
    await waitFor(() => expect(window.sessionStorage.getItem('picpeak.selfUpdate.requestedAt')).toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it('forgets a stale request that never got a run', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    getStatus.mockResolvedValue(status());
    renderPanel();
    expect(await screen.findByRole('button', { name: 'admin.updates.selfUpdate.submit' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem('picpeak.selfUpdate.requestedAt')).toBeNull();
  });

  it('does not fold the manual steps when the feature is off, even with a remembered request', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    getStatus.mockResolvedValue(status({ enabled: false, available: false, reason: 'disabled', agent: null }));
    const Probe = () => <span>{useSelfUpdateActive() ? 'folded' : 'open'}</span>;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    expect(await screen.findByText('open')).toBeInTheDocument();
  });

  it('offers to cancel while the request waits for the updater', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    const job = { id: 'j1', phase: 'requested', started_at: STARTED, requested_at: STARTED, requested_by: 'me', backup: null, error: null };
    getStatus.mockResolvedValue(status({ available: false, reason: 'busy', job }));
    withdrawRequest.mockResolvedValue(undefined);
    renderPanel();
    const cancel = await screen.findByRole('button', { name: 'admin.updates.selfUpdate.cancel' });
    getStatus.mockResolvedValue(status({ job: { ...job, phase: 'withdrawn' } }));
    fireEvent.click(cancel);
    await waitFor(() => expect(withdrawRequest).toHaveBeenCalled());
    expect(await screen.findByText('admin.updates.selfUpdate.result.withdrawn')).toBeInTheDocument();
  });

  it('says when the backend withdrew a request nothing picked up', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    getStatus.mockResolvedValue(status({
      job: { id: 'j1', phase: 'expired', started_at: STARTED, requested_by: 'me', backup: null, error: null },
    }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.result.expired')).toBeInTheDocument();
  });

  it('offers a way out when the job was lost in a restart during the backup', async () => {
    window.sessionStorage.setItem('picpeak.selfUpdate.requestedAt', STARTED);
    // No job (the process was replaced), no run, nothing pending.
    getStatus.mockResolvedValue(status());
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.result.lost')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(window.sessionStorage.getItem('picpeak.selfUpdate.requestedAt')).toBeNull();
  });

  it('tells an SSO-only super admin why there is no form', async () => {
    getStatus.mockResolvedValue(status({ can_request: false, request_block: 'no_local_password' }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.noLocalPassword')).toBeInTheDocument();
    expect(screen.queryByText('admin.updates.selfUpdate.submit')).not.toBeInTheDocument();
  });

  it('explains an unwritable request directory instead of offering the button', async () => {
    getStatus.mockResolvedValue(status({ available: false, reason: 'request_dir_not_writable' }));
    renderPanel();
    expect(await screen.findByText('admin.updates.selfUpdate.requestDirNotWritable')).toBeInTheDocument();
    expect(screen.queryByText('admin.updates.selfUpdate.submit')).not.toBeInTheDocument();
  });

  it('maps the server refusal codes to its own messages', async () => {
    getStatus.mockResolvedValue(status());
    requestUpdate.mockRejectedValue({ response: { status: 409, data: { code: 'SELF_UPDATE_NO_AGENT', error: 'English text' } } });
    renderPanel();
    fireEvent.change(await screen.findByLabelText('admin.updates.selfUpdate.password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'admin.updates.selfUpdate.submit' }));
    expect(await screen.findByText('admin.updates.selfUpdate.error.noAgent')).toBeInTheDocument();
  });
});
