import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { Button, Card } from '../common';
import { useMutationWithToast } from '../../hooks';
import { usePermission } from '../../hooks/usePermission';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import {
  systemHealthService,
  type DependencyState,
  type DegradationStatus,
  type DependencyStatus,
} from '../../services/systemHealth.service';

const GB = 1024 ** 3;

const STATE_ICONS: Record<DependencyState, React.ReactNode> = {
  healthy: <CheckCircle className="w-4 h-4 text-success-text shrink-0" />,
  degraded: <AlertCircle className="w-4 h-4 text-warning-text shrink-0" />,
  down: <XCircle className="w-4 h-4 text-danger-text shrink-0" />,
};

/**
 * The live readings worth showing next to a dependency. Only numbers the probe
 * actually reported: a value it could not read stays out rather than showing 0.
 */
function useMetricLabels() {
  const { t, i18n } = useTranslation();
  return (metrics: DependencyStatus['metrics']): string[] => {
    if (!metrics) return [];
    const labels: string[] = [];
    const add = (value: number | null | undefined, key: string, format = (n: number) => String(Math.round(n))) => {
      if (typeof value === 'number') labels.push(t(`systemHealth.dependencies.metrics.${key}`, { value: format(value) }));
    };
    add(metrics.cpuPercent, 'cpu');
    add(metrics.memoryPercent, 'memory');
    add(metrics.eventLoopDelayMs, 'eventLoop');
    add(metrics.freeBytes, 'free', (bytes) => (bytes / GB).toLocaleString(i18n.language, { maximumFractionDigits: 1 }));
    if (typeof metrics.pendingPhotos === 'number') {
      labels.push(t('systemHealth.dependencies.metrics.pending', { count: metrics.pendingPhotos }));
    }
    return labels;
  };
}

interface ThresholdInputProps {
  label: string;
  saved: number;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (value: number, onError: () => void) => void;
}

/** Saves on blur. A value that is out of range or refused goes back to the saved one. */
const ThresholdInput: React.FC<ThresholdInputProps> = ({ label, saved, min, max, disabled, onSave }) => {
  const [value, setValue] = React.useState(String(saved));
  React.useEffect(() => setValue(String(saved)), [saved]);

  return (
    <label className="text-sm text-body">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          const next = Number(value);
          if (next === saved) return;
          if (!Number.isInteger(next) || next < min || next > max) {
            setValue(String(saved));
            return;
          }
          onSave(next, () => setValue(String(saved)));
        }}
        className="block w-24 mt-1 rounded border border-line bg-transparent px-2 py-1"
      />
    </label>
  );
};

/**
 * Mounted only with status data, so the page's other panels do not depend on
 * the permission context. Forcing a feature off is all an admin can do here:
 * nothing on this panel can turn on what a failed dependency switched off.
 */
const DegradationControls: React.FC<{ status: DegradationStatus }> = ({ status }) => {
  const { t } = useTranslation();
  const canManage = usePermission('system.manage');
  const invalidateKeys = [['system-health-status']];

  const recheck = useMutationWithToast({
    mutationFn: () => systemHealthService.recheckStatus(),
    invalidateKeys,
    successMessage: t('systemHealth.dependencies.recheckedToast'),
    errorMessage: () => t('systemHealth.dependencies.recheckFailed'),
  });
  const save = useMutationWithToast({
    mutationFn: systemHealthService.updateDegradationSettings,
    invalidateKeys,
    successMessage: t('toast.settingsSaved'),
    errorMessage: (error: unknown) => (
      (error as { response?: { data?: { code?: string } } })?.response?.data?.code === 'INVALID_LOAD_THRESHOLDS'
        ? t('systemHealth.dependencies.thresholdsInvalid')
        : t('toast.saveError')
    ),
  });

  if (!canManage) return null;
  const enforcing = status.enforcement === 'enforce';

  return (
    <div className="mt-4 pt-4 border-t border-line space-y-3">
      <label className="flex items-start gap-2 text-sm text-body">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enforcing}
          disabled={save.isPending}
          onChange={() => save.mutate({ enforcement: enforcing ? 'observe' : 'enforce' })}
        />
        <span>
          {t('systemHealth.dependencies.enforce')}
          <span className="block text-xs text-muted">{t('systemHealth.dependencies.enforceHint')}</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {status.capabilities.map(({ name, forced }) => (
          <label key={name} className="flex items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              checked={forced}
              disabled={save.isPending}
              onChange={() => save.mutate({
                forcedOff: forced ? status.forcedOff.filter((other) => other !== name) : [...status.forcedOff, name],
              })}
            />
            {t('systemHealth.dependencies.forceOff', { capability: t(`systemHealth.dependencies.capability.${name}`, name) })}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <ThresholdInput
          label={t('systemHealth.dependencies.cpuThrottle')}
          saved={status.load.throttlePercent}
          min={20}
          max={95}
          disabled={save.isPending}
          onSave={(value, onError) => save.mutate({
            cpuThresholds: { throttlePercent: value, resumePercent: status.load.resumePercent },
          }, { onError })}
        />
        <ThresholdInput
          label={t('systemHealth.dependencies.cpuResume')}
          saved={status.load.resumePercent}
          min={5}
          max={90}
          disabled={save.isPending}
          onSave={(value, onError) => save.mutate({
            cpuThresholds: { throttlePercent: status.load.throttlePercent, resumePercent: value },
          }, { onError })}
        />
      </div>
      <Button variant="secondary" size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
        {t('systemHealth.dependencies.recheck')}
      </Button>
    </div>
  );
};

export const DependencyStatusCard: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const metricLabels = useMetricLabels();

  const { data } = useQuery({
    queryKey: ['system-health-status'],
    queryFn: () => systemHealthService.getStatus(),
    refetchInterval: 15000,
  });

  const dependencies = Object.entries(data?.dependencies ?? {});
  if (dependencies.length === 0) return null;

  return (
    <Card padding="lg" className="mb-4">
      <div className="flex items-center gap-2 mb-1">
        <Activity className="w-5 h-5 text-muted" />
        <h2 className="text-lg font-semibold text-heading">{t('systemHealth.dependencies.title')}</h2>
      </div>
      <p className="text-sm text-soft mb-3">{t('systemHealth.dependencies.description')}</p>

      <ul className="divide-y divide-line">
        {dependencies.map(([name, dependency]) => {
          const metrics = metricLabels(dependency.metrics);
          return (
            <li key={name} className="py-2">
              <div className="flex flex-wrap items-center gap-x-2 text-sm">
                {STATE_ICONS[dependency.state]}
                <span className="font-medium text-heading">{t(`systemHealth.dependencies.name.${name}`, name)}</span>
                <span className="text-muted">{t(`systemHealth.dependencies.state.${dependency.state}`)}</span>
                {dependency.state !== 'healthy' && (
                  <span className="text-xs text-muted">
                    {t('systemHealth.dependencies.since', { time: formatDateTime(dependency.since) })}
                  </span>
                )}
              </div>
              {metrics.length > 0 && <p className="ml-6 text-xs text-muted">{metrics.join(' · ')}</p>}
              {dependency.detail && <p className="ml-6 text-xs text-danger-text break-words">{dependency.detail}</p>}
            </li>
          );
        })}
      </ul>

      {(data?.load?.level ?? 0) > 0 && (
        <p className="mt-3 text-sm text-warning-text">
          {t(data?.load?.applied ? 'systemHealth.dependencies.throttled' : 'systemHealth.dependencies.wouldThrottle')}
        </p>
      )}

      <h3 className="text-sm font-semibold text-heading mt-4 mb-2">{t('systemHealth.dependencies.capabilitiesTitle')}</h3>
      <ul className="space-y-1">
        {(data?.capabilities ?? []).map((capability) => (
          <li key={capability.name} className="flex flex-wrap items-center gap-x-2 text-sm">
            {capability.available && !capability.paused ? STATE_ICONS.healthy : STATE_ICONS.degraded}
            <span className="text-body">{t(`systemHealth.dependencies.capability.${capability.name}`, capability.name)}</span>
            <span className="text-muted">
              {capability.forced
                ? t('systemHealth.dependencies.pausedByAdmin')
                : capability.paused
                  ? t('systemHealth.dependencies.unavailable')
                  : capability.available
                    ? t('systemHealth.dependencies.available')
                    : t('systemHealth.dependencies.wouldPause')}
            </span>
          </li>
        ))}
      </ul>

      {data?.load && (
        <p className="mt-3 text-xs text-muted">
          {t(data.enforcement === 'enforce' ? 'systemHealth.dependencies.modeEnforce' : 'systemHealth.dependencies.modeObserve')}
          {' · '}
          {t('systemHealth.dependencies.thresholds', { throttle: data.load.throttlePercent, resume: data.load.resumePercent })}
        </p>
      )}

      {data && <DegradationControls status={data} />}
    </Card>
  );
};
