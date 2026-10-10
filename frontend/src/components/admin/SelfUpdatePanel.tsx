import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle, Zap } from 'lucide-react';
import { Button, Input, Notice } from '../common';
import { selfUpdateService, SelfUpdateAgentStatus, SelfUpdateStatus } from '../../services/selfUpdate.service';

// Remembers that this browser started an update, across the reload the new
// frontend needs and across the backend restart that drops the server-side job.
const STORAGE_KEY = 'picpeak.selfUpdate.requestedAt';
const WAITING_HINT_AFTER_MS = 2 * 60 * 1000;
// Longest an update can take before it has a result: the host agent's
// TimeoutStartSec. A remembered request older than that, with no run and no
// job to show for it, is from a session that never came back for the result.
const STALE_AFTER_MS = 45 * 60 * 1000;
const TERMINAL_STATES = new Set(['succeeded', 'up_to_date', 'refused', 'failed', 'rolled_back']);
// Reasons the panel only explains: the manual steps stay the way to update.
const NOTE_REASONS = new Set(['no_agent', 'unsupported_contract', 'request_dir_not_writable']);

function readRequestedAt(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRequestedAt(value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: progress still shows until a reload.
  }
}

/**
 * The updater's status for the update this browser asked for, if it has
 * started on it. Compared in whole seconds: the updater writes timestamps
 * without milliseconds, and its run always begins after the backend's dump.
 */
function agentRunFor(status: SelfUpdateStatus | undefined, requestedAt: string): SelfUpdateAgentStatus | null {
  const agent = status?.agent;
  if (!agent?.started_at) return null;
  const started = Date.parse(agent.started_at);
  const requested = Math.floor(Date.parse(requestedAt) / 1000) * 1000;
  if (Number.isNaN(started) || Number.isNaN(requested)) return null;
  return started >= requested ? agent : null;
}

/**
 * True when the one-click panel offers or is running an update. The manual
 * instructions next to it then become the secondary path: their checklist
 * ("I have backed up my database") describes what the one-click flow already
 * does by itself, and showing it under "Update now" says the opposite. Shares
 * the panel's query, so it costs no extra request.
 */
export function useSelfUpdateActive(enabled = true): boolean {
  const { data } = useQuery({
    queryKey: ['self-update-status'],
    queryFn: selfUpdateService.getStatus,
    retry: false,
    enabled,
  });
  const requested = Boolean(readRequestedAt());
  if (!data) return requested;
  // The server's "off" wins over a remembered request: the panel drops that
  // request itself, but sessionStorage does not re-render this hook.
  if (!data.enabled) return false;
  return requested || !(data.reason && NOTE_REASONS.has(data.reason));
}

/** The manual steps, folded away while the one-click path is the way to update. */
export const ManualUpdateSteps: React.FC<{ active: boolean; children: React.ReactNode }> = ({ active, children }) => {
  const { t } = useTranslation();
  if (!active) return <>{children}</>;
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium text-body">
        {t('admin.updates.selfUpdate.manualInstead', 'Update manually instead')}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
};

/**
 * One-click update for installs with the updater enabled (docs/self-update.md).
 * Renders nothing when the feature is off, so the manual instructions next to
 * it stay the whole story for every install that has not opted in.
 */
export const SelfUpdatePanel: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [requestedAt, setRequestedAt] = useState<string | null>(readRequestedAt);
  const [password, setPassword] = useState('');
  const [waitingTooLong, setWaitingTooLong] = useState(false);

  const { data, isError, dataUpdatedAt } = useQuery({
    queryKey: ['self-update-status'],
    queryFn: selfUpdateService.getStatus,
    // While an update runs the backend restarts, so failed polls are expected
    // and must not stop the polling.
    retry: false,
    refetchInterval: (query) => {
      if (!requestedAt) return false;
      const run = agentRunFor(query.state.data, requestedAt);
      return run && run.state && TERMINAL_STATES.has(run.state) ? false : 2000;
    },
  });

  const withdrawal = useMutation({
    mutationFn: () => selfUpdateService.withdrawRequest(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['self-update-status'] }),
  });

  const mutation = useMutation({
    mutationFn: (pw: string) => selfUpdateService.requestUpdate(pw),
    onSuccess: (job) => {
      setPassword('');
      writeRequestedAt(job.started_at);
      setRequestedAt(job.started_at);
      // Show "backing up" now rather than "waiting" until the next poll.
      queryClient.invalidateQueries({ queryKey: ['self-update-status'] });
    },
  });

  const job = data?.job && requestedAt && data.job.started_at === requestedAt ? data.job : null;
  const run = requestedAt ? agentRunFor(data, requestedAt) : null;
  const waitingForUpdater = Boolean(requestedAt && job?.phase === 'requested' && !run);

  useEffect(() => {
    if (!waitingForUpdater || !job?.requested_at) {
      setWaitingTooLong(false);
      return undefined;
    }
    const elapsed = Date.now() - new Date(job.requested_at).getTime();
    const timer = window.setTimeout(() => setWaitingTooLong(true), Math.max(0, WAITING_HINT_AFTER_MS - elapsed));
    return () => window.clearTimeout(timer);
  }, [waitingForUpdater, job?.requested_at]);

  const finish = () => {
    writeRequestedAt(null);
    setRequestedAt(null);
    mutation.reset();
    withdrawal.reset();
  };

  // Forget a remembered request that can no longer resolve: the feature was
  // turned off since, or it is stale. Without this the panel spins on
  // "waiting for the updater" forever.
  const abandoned = Boolean(requestedAt && data && (
    !data.enabled
    || (!job && !run && Date.now() - Date.parse(requestedAt) > STALE_AFTER_MS)
  ));
  useEffect(() => {
    if (abandoned) finish();
    // finish only touches storage, state and the mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abandoned]);

  const errorText = (code?: string, fallback?: string) => {
    switch (code) {
      case 'SELF_UPDATE_BAD_PASSWORD':
        return t('admin.updates.selfUpdate.error.badPassword', 'The password is incorrect.');
      case 'SELF_UPDATE_RATE_LIMITED':
        return t('admin.updates.selfUpdate.error.rateLimited', 'Too many attempts. Try again in a few minutes.');
      case 'SELF_UPDATE_BUSY':
        return t('admin.updates.selfUpdate.error.busy', 'An update is already in progress.');
      case 'SELF_UPDATE_DISABLED':
        return t('admin.updates.selfUpdate.error.disabled', 'In-app updates are not enabled on this installation.');
      case 'SELF_UPDATE_NO_AGENT':
        return t('admin.updates.selfUpdate.error.noAgent', 'The updater is not installed or not reachable.');
      case 'SELF_UPDATE_UNSUPPORTED_CONTRACT':
        return t('admin.updates.selfUpdate.error.unsupportedContract', 'The installed updater does not match this version of PicPeak.');
      case 'SELF_UPDATE_REQUEST_DIR_NOT_WRITABLE':
        return t('admin.updates.selfUpdate.error.requestDirNotWritable', 'PicPeak cannot write to its update request directory.');
      case 'SELF_UPDATE_NO_LOCAL_PASSWORD':
        return t('admin.updates.selfUpdate.error.noLocalPassword', 'In-app updates need a super admin who signs in with a password.');
      default:
        return fallback || t('admin.updates.selfUpdate.error.generic', 'The update could not be started.');
    }
  };

  const stepText = (step: string | null) => {
    switch (step) {
      case 'discover': return t('admin.updates.selfUpdate.step.discover', 'Checking the installation…');
      case 'pull': return t('admin.updates.selfUpdate.step.pull', 'Downloading the new version…');
      case 'verify': return t('admin.updates.selfUpdate.step.verify', 'Checking the new version…');
      case 'recreate': return t('admin.updates.selfUpdate.step.recreate', 'Installing the new version…');
      case 'health': return t('admin.updates.selfUpdate.step.health', 'Waiting for PicPeak to start…');
      case 'rollback': return t('admin.updates.selfUpdate.step.rollback', 'The new version did not start. Bringing back the previous one…');
      default: return t('admin.updates.selfUpdate.step.working', 'Updating…');
    }
  };

  const shell = (children: React.ReactNode) => (
    <Notice
      tone="info"
      icon={<Zap className="w-4 h-4" />}
      title={<span className="font-semibold">{t('admin.updates.selfUpdate.title', 'Update from here')}</span>}
    >
      <div className="mt-2 space-y-3">{children}</div>
    </Notice>
  );

  const progressLine = (text: string) => (
    <p className="flex items-center gap-2 text-sm text-body" role="status" aria-live="polite">
      <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
      {text}
    </p>
  );

  // An update this browser started: show it through to the end, whatever the
  // status endpoint says in between (the backend is down for part of it).
  if (requestedAt && !abandoned) {
    // The request is gone without the updater taking it: cancelled here,
    // withdrawn after waiting too long, or lost because PicPeak restarted
    // during the backup (the job lived only in that process).
    // Only judged on a status fetched after the request was made: until the
    // refetch lands, the cached one predates the job.
    const lost = Boolean(data && !isError && !run && data.reason !== 'busy'
      && dataUpdatedAt > Date.parse(requestedAt)
      && (!job || job.phase === 'withdrawn' || job.phase === 'expired'));
    if (lost) {
      const text = job?.phase === 'withdrawn'
        ? t('admin.updates.selfUpdate.result.withdrawn', 'The update request was cancelled. Nothing was changed.')
        : job?.phase === 'expired'
          ? t('admin.updates.selfUpdate.result.expired', 'The updater did not pick up the request in time, so it was withdrawn. Nothing was changed. Check that the updater is running, then try again.')
          : t('admin.updates.selfUpdate.result.lost', 'The update request did not reach the updater (PicPeak restarted, or the request was withdrawn). Nothing was changed.');
      return shell(
        <>
          <p className="flex items-start gap-2 text-sm text-warning-text">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            {text}
          </p>
          <Button size="sm" variant="outline" onClick={finish}>{t('common.close', 'Close')}</Button>
        </>
      );
    }

    if (job?.phase === 'backup_failed' || job?.phase === 'request_failed') {
      return shell(
        <>
          <p className="flex items-start gap-2 text-sm text-danger-text">
            <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            {job.phase === 'backup_failed'
              ? t('admin.updates.selfUpdate.result.backupFailed', 'The database backup failed, so the update was not started. Nothing was changed.')
              : t('admin.updates.selfUpdate.result.requestFailed', 'The backup was taken, but the update request could not be filed. Nothing was changed.')}
          </p>
          {job.error && <p className="text-xs text-soft break-words">{job.error}</p>}
          <Button size="sm" variant="outline" onClick={finish}>{t('common.close', 'Close')}</Button>
        </>
      );
    }

    if (run?.state && TERMINAL_STATES.has(run.state)) {
      const ok = run.state === 'succeeded' || run.state === 'up_to_date';
      const headline = {
        succeeded: t('admin.updates.selfUpdate.result.succeeded', 'PicPeak was updated.'),
        up_to_date: t('admin.updates.selfUpdate.result.upToDate', 'PicPeak is already on the latest version of its channel.'),
        refused: t('admin.updates.selfUpdate.result.refused', 'The update was not installed. Nothing was changed.'),
        failed: t('admin.updates.selfUpdate.result.failed', 'The update failed.'),
        rolled_back: t('admin.updates.selfUpdate.result.rolledBack', 'The new version did not start, so the previous version was brought back.'),
      }[run.state];
      return shell(
        <>
          <p className={`flex items-start gap-2 text-sm ${ok ? 'text-success-text' : 'text-danger-text'}`}>
            {ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
            {headline}
          </p>
          {run.message && (
            // The updater's own explanation. It is English: it comes from the
            // server-side script and names versions and causes precisely.
            <p className="text-xs text-soft break-words">{run.message}</p>
          )}
          {run.state === 'succeeded' ? (
            <Button size="sm" onClick={() => { finish(); window.location.reload(); }}>
              <RefreshCw className="w-4 h-4 mr-1.5" />
              {t('admin.updates.selfUpdate.reload', 'Reload PicPeak')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={finish}>{t('common.close', 'Close')}</Button>
          )}
        </>
      );
    }

    let text: string;
    if (job?.phase === 'backing_up') text = t('admin.updates.selfUpdate.phase.backingUp', 'Backing up the database…');
    else if (run) text = stepText(run.step);
    else if (isError) text = t('admin.updates.selfUpdate.phase.restarting', 'PicPeak is restarting…');
    else text = t('admin.updates.selfUpdate.phase.waiting', 'Waiting for the updater to start…');

    return shell(
      <>
        {progressLine(text)}
        <p className="text-xs text-soft">
          {t('admin.updates.selfUpdate.keepOpen', 'You can keep this window open. The site is unavailable for a minute or two while the new version starts.')}
        </p>
        {waitingTooLong && (
          <p className="flex items-start gap-2 text-xs text-warning-text">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {t('admin.updates.selfUpdate.phase.waitingLong', 'The updater has not picked up the request yet. Check that it is running on the server (journalctl -u picpeak-updater, or the updater container).')}
          </p>
        )}
        {waitingForUpdater && data?.can_request && (
          <Button size="sm" variant="outline" disabled={withdrawal.isPending} onClick={() => withdrawal.mutate()}>
            {t('admin.updates.selfUpdate.cancel', 'Cancel request')}
          </Button>
        )}
      </>
    );
  }

  if (!data?.enabled) return null;

  if (data.reason && NOTE_REASONS.has(data.reason)) {
    const note = {
      no_agent: t('admin.updates.selfUpdate.noAgent', 'In-app updates are enabled, but the updater is not installed or not reachable. Use the commands below, or set it up as described in docs/self-update.md.'),
      unsupported_contract: t('admin.updates.selfUpdate.unsupportedContract', 'The installed updater does not match this version of PicPeak. Refresh it with picpeak-setup.sh --update, or update the updater container.'),
      request_dir_not_writable: t('admin.updates.selfUpdate.requestDirNotWritable', 'PicPeak cannot write to its update request directory (update/request), so it cannot ask for an update. It has to be writable by UID 1001; see docs/self-update.md.'),
    }[data.reason];
    return shell(
      <p className="flex items-start gap-2 text-sm text-warning-text">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        {note}
      </p>
    );
  }

  if (data.reason === 'busy') {
    return shell(progressLine(t('admin.updates.selfUpdate.busyOther', 'An update is already in progress.')));
  }

  if (!data.can_request) {
    return shell(
      <p className="text-sm text-body">
        {data.request_block === 'no_local_password'
          ? t('admin.updates.selfUpdate.noLocalPassword', 'In-app updates need a super admin who signs in with a password. Your account signs in through SSO only.')
          : t('admin.updates.selfUpdate.onlySuperAdmin', 'A super admin can update PicPeak from here.')}
      </p>
    );
  }

  const mutationError = mutation.error as { response?: { data?: { code?: string; error?: string } } } | null;

  return shell(
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) mutation.mutate(password);
      }}
    >
      <p className="text-sm text-body">
        {t('admin.updates.selfUpdate.description', 'PicPeak backs up its database, then installs the latest version of its release channel. The site is unavailable for a minute or two while it restarts.')}
      </p>
      <Input
        type="password"
        autoComplete="current-password"
        label={t('admin.updates.selfUpdate.password', 'Confirm with your password')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={mutationError ? errorText(mutationError.response?.data?.code, mutationError.response?.data?.error) : undefined}
      />
      <Button type="submit" size="sm" disabled={!password || mutation.isPending}>
        {mutation.isPending
          ? t('admin.updates.selfUpdate.submitting', 'Starting…')
          : t('admin.updates.selfUpdate.submit', 'Update now')}
      </Button>
    </form>
  );
};
