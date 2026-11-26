import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PicpeakRestoreCard } from './PicpeakBackupCard';
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Upload,
  HardDrive,
  Cloud,
  Server,
  Database,
  Image,
  FileArchive,
  Info,
  ChevronRight,
  ChevronLeft,
  Loader2,
  Download,
  Eye,
  Calendar,
  Clock,
  AlertCircle,
  ShieldCheck
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input, Loading } from '../common';
import { api } from '../../config/api';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { backupErrorCode, backupErrorText } from '../../utils/backupErrors';
import {
  clearRestoreRun, isRunOf, readRestoreRun, rearmRestoreRedirect, rememberRestoreRun, RESTORE_RUN_GRACE_MS,
} from '../../utils/restoreRelogin';

// restore_runs booleans arrive as true/false from PostgreSQL but as 1/0 from
// SQLite; a bare `{row.flag && …}` renders the 0 as text.
const dbFlag = (value) => value === true || value === 1 || value === '1' || value === 'true';
const dbFlagFalse = (value) => value === false || value === 0 || value === '0' || value === 'false';

// Warning codes the backend explains (performPreRestoreValidation); any other
// warning is listed with its plain message only.
const NOTICE_CODES = ['backup_age', 'version_newer', 'version_other_line', 'version_unknown',
  'version_older', 'existing_events', 'active_admins'];

export const RestoreWizard = ({ onVerifyIntegrity } = {}) => {
  const { t } = useTranslation();
  const { format: fmtDate, formatTime: fmtTime, formatDateTime: fmtDateTime } = useLocalizedDate();
  const queryClient = useQueryClient();
  // The run this wizard started (restoreRelogin.ts). Read from sessionStorage
  // on mount, so a restore that signed the admin out reopens on its result.
  const [trackedRun, setTrackedRun] = useState(readRestoreRun);
  const [currentStep, setCurrentStep] = useState(() => (trackedRun ? 4 : 0));
  
  const steps = [
    { id: 'source', title: t('backup.restore.steps.selectSource') },
    { id: 'backup', title: t('backup.restore.steps.chooseBackup') },
    { id: 'options', title: t('backup.restore.steps.restoreOptions') },
    { id: 'confirm', title: t('backup.restore.steps.reviewConfirm') },
    { id: 'progress', title: t('backup.restore.steps.progress') }
  ];

  const restoreTypes = [
    {
      id: 'full',
      name: t('backup.restore.restoreTypes.full.name'),
      description: t('backup.restore.restoreTypes.full.description'),
      icon: RefreshCw,
      warning: t('backup.restore.restoreTypes.full.warning')
    },
    {
      id: 'database',
      name: t('backup.restore.restoreTypes.database.name'),
      description: t('backup.restore.restoreTypes.database.description'),
      icon: Database,
      warning: t('backup.restore.restoreTypes.database.warning')
    },
    {
      id: 'files',
      name: t('backup.restore.restoreTypes.files.name'),
      description: t('backup.restore.restoreTypes.files.description'),
      icon: Image,
      warning: t('backup.restore.restoreTypes.files.warning')
    },
    {
      id: 'selective',
      name: t('backup.restore.restoreTypes.selective.name'),
      description: t('backup.restore.restoreTypes.selective.description'),
      icon: CheckCircle,
      warning: t('backup.restore.restoreTypes.selective.warning')
    }
  ];
  
  const [restoreData, setRestoreData] = useState({
    source: null,
    sourceConfig: {},
    selectedBackup: null,
    restoreType: 'full',
    selectedItems: [],
    skipPreBackup: false,
    force: false
  });
  const [validationResult, setValidationResult] = useState(null);

  // Fetch restore status
  const { data: restoreStatus, error: restoreStatusError, dataUpdatedAt: restoreStatusAt } = useQuery({
    queryKey: ['restore-status'],
    queryFn: async () => {
      const response = await api.get('/admin/restore/status');
      return response.data.data;
    },
    refetchInterval: currentStep === 4 ? 2000 : false // Poll during restore
  });

  // The admin reached the tracked run, so a later sign-out may bring them
  // back here (the login page follows the marker only once otherwise).
  useEffect(() => {
    if (trackedRun) rearmRestoreRedirect();
  }, []);

  // Exactly the run this admin started: a later restore or dry run by
  // someone else must not stand in for it.
  const trackedRow = trackedRun ? restoreStatus?.history?.find((row) => isRunOf(row, trackedRun)) : undefined;
  // Once the tracked run has an outcome, it is on screen: drop the marker so
  // the next sign-in in this tab goes to the dashboard again. Same when this
  // admin may not read the restore status at all.
  // The run's own row decides: another admin's restore or dry run may be
  // running by the time this one is read back.
  const trackedRunFinished = !!trackedRow && trackedRow.status !== 'running';
  const statusForbidden = restoreStatusError?.response?.status === 403;
  useEffect(() => {
    if (trackedRunFinished || statusForbidden) clearRestoreRun();
  }, [trackedRunFinished, statusForbidden]);

  // Nothing is running and the run has no row: it may still be about to
  // start. After the grace period it did not start (or its row cannot be
  // read), so stop waiting and say so instead of "Starting..." forever.
  const [trackedRunMissing, setTrackedRunMissing] = useState(false);
  // Only a status read after the start counts: a failing poll keeps the
  // cached pre-start answer, which says nothing about this run.
  const awaitingTrackedRow = !!trackedRun && !restoreStatusError && restoreStatusAt >= trackedRun.since
    && restoreStatus?.isRunning === false && !trackedRow;
  useEffect(() => {
    if (!awaitingTrackedRow) {
      setTrackedRunMissing(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setTrackedRunMissing(true);
      clearRestoreRun();
    }, Math.max(0, trackedRun.since + RESTORE_RUN_GRACE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [awaitingTrackedRow, trackedRun]);

  // Fetch available backups
  const { data: backupListing, isLoading: loadingBackups } = useQuery({
    queryKey: ['available-backups', restoreData.source, restoreData.sourceConfig],
    queryFn: async () => {
      const response = await api.post('/admin/restore/list-backups', {
        source: restoreData.source,
        ...restoreData.sourceConfig
      });
      // remoteError: the rsync destination could not be read; the local
      // restore points are still listed.
      return { backups: response.data.data, remoteError: response.data.remoteError || null };
    },
    enabled: currentStep === 1 && !!restoreData.source
  });

  const availableBackups = backupListing?.backups;
  const remoteErrorText = backupListing?.remoteError
    ? backupErrorText(backupErrorCode({ code: backupListing.remoteError.code }), t) : null;
  // A restore point on the rsync destination is restored with its own source.
  const restoreSource = () => restoreData.selectedBackup?.restore_source || restoreData.source;

  // Validate restore
  const validateMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/admin/restore/validate', {
        source: restoreSource(),
        manifestPath: restoreData.selectedBackup.manifest_path,
        restoreType: restoreData.restoreType,
        selectedItems: restoreData.selectedItems,
        ...restoreData.sourceConfig
      });
      return response.data.data;
    },
    onSuccess: (data) => {
      setValidationResult(data);
      // The override is given for the warnings shown in this review, so a
      // new validation asks for it again.
      setRestoreData(prev => ({ ...prev, force: false }));
      setCurrentStep(3);
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Validation failed');
    }
  });

  // Start restore
  const restoreMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/admin/restore/start', {
        source: restoreSource(),
        manifestPath: restoreData.selectedBackup.manifest_path,
        restoreType: restoreData.restoreType,
        selectedItems: restoreData.selectedItems,
        skipPreBackup: restoreData.skipPreBackup,
        force: restoreData.force,
        ...restoreData.sourceConfig
      });
      return response.data;
    },
    onSuccess: (data) => {
      // Only the restore_runs row with exactly this started_at is this run's
      // result; the cached status still names the previous run.
      if (data?.runStartedAt) {
        const marker = { runStartedAt: data.runStartedAt, since: Date.now() };
        rememberRestoreRun(marker);
        setTrackedRun(marker);
      }
      queryClient.invalidateQueries({ queryKey: ['restore-status'] });
      setCurrentStep(4);
      toast.success('Restore started successfully');
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to start restore');
    }
  });

  const handleNext = () => {
    if (currentStep === 2) {
      // Validate before confirmation
      validateMutation.mutate();
    } else if (currentStep === 3) {
      // Start restore
      restoreMutation.mutate();
    } else {
      setCurrentStep(prev => Math.min(prev + 1, steps.length - 1));
    }
  };

  const handleBack = () => {
    setCurrentStep(prev => Math.max(prev - 1, 0));
  };

  // What the review step found. Warnings block the restore unless the admin
  // overrides them there (force); older validation payloads only carry the
  // plain warning strings.
  const validation = validationResult?.validation;
  const validationErrors = validation?.errors || [];
  const notices = validation?.notices
    || (validation?.warnings || []).map((message) => ({ severity: 'warning', code: null, message, params: {} }));
  const warningNotices = notices.filter((notice) => notice.severity === 'warning');
  const infoNotices = notices.filter((notice) => notice.severity !== 'warning');
  const hasErrors = !!validation && (validation.isValid === false || validationErrors.length > 0);
  const needsOverride = hasErrors || warningNotices.length > 0;
  const noticeKnown = (notice) => NOTICE_CODES.includes(notice.code);
  const noticeTitle = (notice) => (noticeKnown(notice)
    ? t(`backup.restore.confirmation.notices.${notice.code}.title`, notice.params || {})
    : notice.message);
  const noticeHelp = (notice) => (noticeKnown(notice)
    ? t(`backup.restore.confirmation.notices.${notice.code}.help`, notice.params || {})
    : t('backup.restore.confirmation.notices.generic.help'));
  // /admin/restore/start refuses force when the restore settings turn it off.
  const forceAllowed = restoreStatus?.settings?.restore_allow_force !== false;

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return !!restoreData.source;
      case 1:
        return !!restoreData.selectedBackup;
      case 2:
        return !!restoreData.restoreType;
      case 3:
        return !!validationResult && !validateMutation.isLoading
          && (!needsOverride || (restoreData.force && forceAllowed));
      default:
        return false;
    }
  };

  // Step Components
  const renderSourceSelection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-heading mb-2">{t('backup.restore.source.title')}</h3>
        <p className="text-sm text-soft">{t('backup.restore.source.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button
          onClick={() => setRestoreData(prev => ({ ...prev, source: 'local' }))}
          className={`p-6 rounded-lg border-2 transition-all ${
            restoreData.source === 'local'
              ? 'border-accent bg-accent-soft'
              : 'border-line hover:border-line-strong'
          }`}
        >
          <HardDrive className={`h-12 w-12 mb-3 mx-auto ${
            restoreData.source === 'local' ? 'text-accent' : 'text-faint'
          }`} />
          <h4 className="font-medium text-heading">{t('backup.restore.source.local.name')}</h4>
          <p className="text-xs text-muted mt-1">{t('backup.restore.source.local.description')}</p>
        </button>

        <button
          onClick={() => setRestoreData(prev => ({ ...prev, source: 's3' }))}
          className={`p-6 rounded-lg border-2 transition-all ${
            restoreData.source === 's3'
              ? 'border-accent bg-accent-soft'
              : 'border-line hover:border-line-strong'
          }`}
        >
          <Cloud className={`h-12 w-12 mb-3 mx-auto ${
            restoreData.source === 's3' ? 'text-accent' : 'text-faint'
          }`} />
          <h4 className="font-medium text-heading">{t('backup.restore.source.s3.name')}</h4>
          <p className="text-xs text-muted mt-1">{t('backup.restore.source.s3.description')}</p>
        </button>

        <button
          onClick={() => setRestoreData(prev => ({ ...prev, source: 'upload' }))}
          className={`p-6 rounded-lg border-2 transition-all ${
            restoreData.source === 'upload'
              ? 'border-accent bg-accent-soft'
              : 'border-line hover:border-line-strong'
          }`}
        >
          <Upload className={`h-12 w-12 mb-3 mx-auto ${
            restoreData.source === 'upload' ? 'text-accent' : 'text-faint'
          }`} />
          <h4 className="font-medium text-heading">{t('backup.restore.source.upload.name')}</h4>
          <p className="text-xs text-muted mt-1">{t('backup.restore.source.upload.description')}</p>
        </button>
      </div>

      {/* Source-specific configuration */}
      {restoreData.source === 's3' && (
        <Card className="p-4 space-y-4">
          <h4 className="font-medium text-heading">{t('backup.restore.source.configuration.s3')}</h4>
          <div className="grid grid-cols-2 gap-4">
            <Input
              placeholder={t('backup.restore.source.configuration.endpoint')}
              value={restoreData.sourceConfig.s3Endpoint || ''}
              onChange={(e) => setRestoreData(prev => ({
                ...prev,
                sourceConfig: { ...prev.sourceConfig, s3Endpoint: e.target.value }
              }))}
            />
            <Input
              placeholder={t('backup.restore.source.configuration.bucket')}
              value={restoreData.sourceConfig.s3Bucket || ''}
              onChange={(e) => setRestoreData(prev => ({
                ...prev,
                sourceConfig: { ...prev.sourceConfig, s3Bucket: e.target.value }
              }))}
            />
            <Input
              placeholder={t('backup.restore.source.configuration.accessKey')}
              value={restoreData.sourceConfig.s3AccessKey || ''}
              onChange={(e) => setRestoreData(prev => ({
                ...prev,
                sourceConfig: { ...prev.sourceConfig, s3AccessKey: e.target.value }
              }))}
            />
            <Input
              type="password"
              placeholder={t('backup.restore.source.configuration.secretKey')}
              value={restoreData.sourceConfig.s3SecretKey || ''}
              onChange={(e) => setRestoreData(prev => ({
                ...prev,
                sourceConfig: { ...prev.sourceConfig, s3SecretKey: e.target.value }
              }))}
            />
          </div>
        </Card>
      )}

      {restoreData.source === 'upload' && (
        <div className="space-y-4">
          {/* Two upload kinds: the working portable .picpeak restore, and the
              legacy manifest+files upload (still a stub). */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              onClick={() => setRestoreData(prev => ({ ...prev, uploadType: 'picpeak' }))}
              className={`p-6 rounded-lg border-2 transition-all ${
                restoreData.uploadType === 'picpeak'
                  ? 'border-accent bg-accent-soft'
                  : 'border-line hover:border-line-strong'
              }`}
            >
              <FileArchive className={`h-10 w-10 mb-2 mx-auto ${restoreData.uploadType === 'picpeak' ? 'text-accent' : 'text-neutral-400'}`} />
              <h4 className="font-medium text-heading">{t('backup.restore.source.upload.picpeak.name', '.picpeak backup')}</h4>
              <p className="text-xs text-muted mt-1">{t('backup.restore.source.upload.picpeak.description', 'Portable full backup — restores everything (full override, keeps your current account).')}</p>
            </button>
            <button
              onClick={() => setRestoreData(prev => ({ ...prev, uploadType: 'manifest' }))}
              className={`p-6 rounded-lg border-2 transition-all ${
                restoreData.uploadType === 'manifest'
                  ? 'border-accent bg-accent-soft'
                  : 'border-line hover:border-line-strong'
              }`}
            >
              <Upload className={`h-10 w-10 mb-2 mx-auto ${restoreData.uploadType === 'manifest' ? 'text-accent' : 'text-neutral-400'}`} />
              <h4 className="font-medium text-heading">{t('backup.restore.source.upload.manifest.name', 'Manifest + files')}</h4>
              <p className="text-xs text-muted mt-1">{t('backup.restore.source.upload.manifest.description', 'Upload a manifest and its backup files (legacy format).')}</p>
            </button>
          </div>

          {restoreData.uploadType === 'picpeak' && <PicpeakRestoreCard />}

          {restoreData.uploadType === 'manifest' && (
            <Card className="p-4">
              <div className="text-center py-8">
                <Upload className="h-12 w-12 mx-auto mb-3 text-faint" />
                <p className="text-sm text-soft">{t('backup.restore.source.upload.manifestComingSoon', 'Manifest Upload functionality coming soon')}</p>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );

  const renderBackupSelection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-heading mb-2">{t('backup.restore.backup.title')}</h3>
        <p className="text-sm text-soft">{t('backup.restore.backup.subtitle')}</p>
      </div>

      {backupListing?.remoteError && (
        <Card className="p-4 bg-warning-soft border-warning-line">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="h-5 w-5 text-warning-text mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-warning-text">
                {t('backup.restore.backup.remoteUnavailable.title', 'The rsync destination could not be read')}
              </p>
              <p className="mt-1 text-sm text-warning-text">
                {t('backup.restore.backup.remoteUnavailable.message',
                  'Restore points stored only on the rsync destination are not listed. Check the connection under Backup settings, then reopen this step.')}
              </p>
              {remoteErrorText && <p className="mt-1 text-sm text-warning-text">{remoteErrorText}</p>}
              <p className="mt-1 text-xs font-mono text-warning-text break-words">{backupListing.remoteError.message}</p>
            </div>
          </div>
        </Card>
      )}

      {loadingBackups ? (
        <Loading />
      ) : availableBackups?.length === 0 ? (
        <Card className="p-8 text-center">
          <FileArchive className="h-12 w-12 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
          <p className="text-muted">{t('backup.restore.backup.noBackupsFound')}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {availableBackups?.map((backup) => (
            <Card
              key={backup.id}
              className={`p-4 cursor-pointer transition-all ${
                restoreData.selectedBackup?.id === backup.id
                  ? 'ring-2 ring-accent bg-accent-soft'
                  : 'hover:shadow-md'
              }`}
              onClick={() => setRestoreData(prev => ({ ...prev, selectedBackup: backup }))}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className={`p-2 rounded-lg ${
                    backup.status === 'completed' ? 'bg-success-soft' : 'bg-warning-soft'
                  }`}>
                    {backup.status === 'completed' ? (
                      <CheckCircle className="h-6 w-6 text-success-text" />
                    ) : (
                      <AlertCircle className="h-6 w-6 text-warning-text" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-heading">
                      {fmtDate(backup.created_at)} {t('backup.restore.backup.at')} {fmtTime(backup.created_at)}
                    </p>
                    <p className="text-sm text-muted">
                      {t('backup.dashboard.backupType', { type: backup.backup_type })} • {formatBytes(backup.total_size || 0)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {backup.restore_source === 'rsync' && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-info-soft text-info-text border border-info-line"
                      title={t('backup.restore.backup.remoteHint',
                        'Stored on the rsync destination. The restore downloads what it needs into a private temporary directory first.')}
                    >
                      <Server className="h-3 w-3" />
                      {t('backup.restore.backup.remoteBadge', 'Rsync destination')}
                    </span>
                  )}
                  {/* Files-only warning — backend's /list-backups now
                      returns `database_included: boolean` parsed from
                      the manifest's database.backup_file field. A row
                      where this is false is exactly the data-loss
                      scenario the Stage A guard prevents going forward:
                      a manifest written without an inline DB dump.
                      Restoring it would NOT bring CRM data back. */}
                  {backup.database_included === false && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-danger-soft text-danger-text border border-danger-line"
                      title={t('backup.restore.backup.filesOnlyHint',
                        'This backup has no database dump — restoring it will NOT recover the database (CRM data, customers, quotes, invoices, contracts will be empty after restore).')}
                    >
                      <AlertCircle className="h-3 w-3" />
                      {t('backup.restore.backup.filesOnlyBadge', 'No DB')}
                    </span>
                  )}
                  {backup.corrupt && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-warning-soft text-warning-text border border-warning-line"
                      title={t('backup.restore.backup.corruptHint',
                        'The manifest file is unreadable — the backup may be incomplete or damaged.')}
                    >
                      <AlertCircle className="h-3 w-3" />
                      {t('backup.restore.backup.corruptBadge', 'Corrupt')}
                    </span>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Files-only callout below the selected card. Reinforces the
          badge with a longer explanation + reminds the admin that
          restoring this WILL still proceed — they just won't get the
          DB back. Stops the silent-failure class that originally
          caused Ralf's 2026-05-29 data loss (four files-only manifests
          mistaken for full backups). */}
      {restoreData.selectedBackup && restoreData.selectedBackup.database_included === false && (
        <Card className="p-4 bg-danger-soft border-danger-line">
          <div className="flex items-start space-x-3">
            <AlertCircle className="h-5 w-5 text-danger-text mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-danger-text">
                {t('backup.restore.backup.filesOnlyWarning.title',
                  'Selected backup has no database dump')}
              </p>
              <p className="mt-1 text-sm text-danger-text">
                {t('backup.restore.backup.filesOnlyWarning.message',
                  'Restoring this backup will recover files (photos, PDFs) but the database — including admin users, customers, quotes, invoices, contracts, and settings — will NOT come back. Pick a different backup if you have one with a database dump, or proceed only if files-only is what you want.')}
              </p>
            </div>
          </div>
        </Card>
      )}

    </div>
  );

  const renderRestoreOptions = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-heading mb-2">{t('backup.restore.options.title')}</h3>
        <p className="text-sm text-soft">{t('backup.restore.options.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {restoreTypes.map((type) => {
          const Icon = type.icon;
          return (
            <button
              key={type.id}
              onClick={() => setRestoreData(prev => ({ ...prev, restoreType: type.id }))}
              className={`p-4 rounded-lg border-2 text-left transition-all ${
                restoreData.restoreType === type.id
                  ? 'border-accent bg-accent-soft'
                  : 'border-line hover:border-line-strong'
              }`}
            >
              <div className="flex items-start space-x-3">
                <Icon className={`h-6 w-6 mt-1 ${
                  restoreData.restoreType === type.id ? 'text-accent' : 'text-faint'
                }`} />
                <div className="flex-1">
                  <h4 className="font-medium text-heading">{type.name}</h4>
                  <p className="text-sm text-soft mt-1">{type.description}</p>
                  <p className="text-xs text-warning-text mt-2">
                    <AlertTriangle className="inline h-3 w-3 mr-1" />
                    {type.warning}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Additional Options */}
      <Card className="p-4 space-y-4">
        <h4 className="font-medium text-heading">{t('backup.restore.options.additionalOptions.title')}</h4>

        <label className="flex items-start space-x-3">
          <input
            type="checkbox"
            checked={restoreData.skipPreBackup}
            onChange={(e) => setRestoreData(prev => ({
              ...prev,
              skipPreBackup: e.target.checked
            }))}
            className="mt-1 h-4 w-4 text-accent focus:ring-accent border-line-strong rounded bg-inset"
          />
          <div>
            <p className="text-sm font-medium text-body">{t('backup.restore.options.additionalOptions.skipPreBackup')}</p>
            <p className="text-xs text-muted">
              {t('backup.restore.options.additionalOptions.skipPreBackupHelp')}
            </p>
          </div>
        </label>
      </Card>
    </div>
  );

  const renderConfirmation = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-heading mb-2">{t('backup.restore.confirmation.title')}</h3>
        <p className="text-sm text-soft">{t('backup.restore.confirmation.subtitle')}</p>
      </div>

      {validationResult ? (
        <>
          {/* Validation Results */}
          <Card className={`p-4 ${
            hasErrors
              ? 'bg-danger-soft border-danger-line'
              : warningNotices.length > 0
                ? 'bg-warning-soft border-warning-line'
                : 'bg-success-soft border-success-line'
          }`}>
            <div className="flex items-start space-x-3">
              {hasErrors ? (
                <XCircle className="h-5 w-5 text-danger-text mt-0.5" />
              ) : warningNotices.length > 0 ? (
                <AlertTriangle className="h-5 w-5 text-warning mt-0.5" />
              ) : (
                <CheckCircle className="h-5 w-5 text-success-text mt-0.5" />
              )}
              <div className="flex-1">
                <p className={`text-sm font-medium ${
                  hasErrors ? 'text-danger-text' : warningNotices.length > 0 ? 'text-warning-text' : 'text-success-text'
                }`}>
                  {hasErrors
                    ? t('backup.restore.confirmation.validation.failed')
                    : warningNotices.length > 0
                      ? t('backup.restore.confirmation.validation.passedWithWarnings')
                      : t('backup.restore.confirmation.validation.passed')}
                </p>
                {validationErrors.length > 0 && (
                  <ul className="mt-2 text-sm text-danger-text list-disc list-inside">
                    {validationErrors.map((error, idx) => (
                      <li key={idx}>{error}</li>
                    ))}
                  </ul>
                )}
                {warningNotices.length > 0 && (
                  <ul className="mt-3 space-y-3" aria-label={t('backup.restore.confirmation.notices.warningsLabel')}>
                    {warningNotices.map((notice, idx) => (
                      <li key={idx} className="text-sm text-warning-text">
                        <p className="font-medium">{noticeTitle(notice)}</p>
                        <p className="mt-0.5">{noticeHelp(notice)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          {infoNotices.length > 0 && (
            <Card className="p-4">
              <ul className="space-y-2">
                {infoNotices.map((notice, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-soft">
                    <Info className="h-4 w-4 text-info mt-0.5 flex-shrink-0" />
                    <span>
                      <span className="font-medium text-body">{noticeTitle(notice)}</span>{' '}
                      {noticeHelp(notice)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Space Check */}
          {validationResult.spaceCheck && (
            <Card className="p-4">
              <h4 className="font-medium text-heading mb-3">{t('backup.restore.confirmation.spaceCheck.title')}</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-soft">{t('backup.restore.confirmation.spaceCheck.required')}:</span>
                  <span className="font-medium text-heading">
                    {validationResult.spaceCheck.requiredFormatted || formatBytes(validationResult.spaceCheck.required || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-soft">{t('backup.restore.confirmation.spaceCheck.available')}:</span>
                  <span className="font-medium text-heading">
                    {validationResult.spaceCheck.availableFormatted ||
                     (validationResult.spaceCheck.available != null ? formatBytes(validationResult.spaceCheck.available) : t('common.unknown', 'Unknown'))}
                  </span>
                </div>
                {validationResult.spaceCheck.sufficient === false && (
                  <p className="text-danger-text text-xs mt-2">
                    <AlertCircle className="inline h-3 w-3 mr-1" />
                    {t('backup.restore.confirmation.spaceCheck.insufficient')}
                  </p>
                )}
              </div>
            </Card>
          )}

          {/* Summary */}
          <Card className="p-4">
            <h4 className="font-medium text-heading mb-3">{t('backup.restore.confirmation.summary.title')}</h4>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-soft">{t('backup.restore.confirmation.summary.source')}:</dt>
                <dd className="font-medium text-heading capitalize">{restoreData.source}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-soft">{t('backup.restore.confirmation.summary.backupDate')}:</dt>
                <dd className="font-medium text-heading">
                  {fmtDateTime(restoreData.selectedBackup.created_at)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-soft">{t('backup.restore.confirmation.summary.restoreType')}:</dt>
                <dd className="font-medium text-heading capitalize">{restoreData.restoreType}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-soft">{t('backup.restore.confirmation.summary.preBackup')}:</dt>
                <dd className="font-medium text-heading">{restoreData.skipPreBackup ? t('backup.restore.confirmation.summary.skipped') : t('backup.restore.confirmation.summary.enabled')}</dd>
              </div>
            </dl>
          </Card>

          {/* Warning */}
          <div className="bg-warning-soft border border-warning-line rounded-lg p-4">
            <div className="flex">
              <AlertTriangle className="h-5 w-5 text-warning mt-0.5" />
              <div className="ml-3">
                <h3 className="text-sm font-medium text-warning-text">
                  {t('backup.restore.confirmation.warning.title')}
                </h3>
                <p className="mt-1 text-sm text-warning-text">
                  {t('backup.restore.confirmation.warning.message')}
                </p>
              </div>
            </div>
          </div>

          {/* The one override control: force is only known to be needed
              once validation has run, so it lives here and not in the
              options step. */}
          {needsOverride && (
            <Card className="p-4">
              <label className="flex items-start space-x-3">
                <input
                  type="checkbox"
                  checked={restoreData.force}
                  disabled={!forceAllowed}
                  onChange={(e) => setRestoreData(prev => ({
                    ...prev,
                    force: e.target.checked
                  }))}
                  className="mt-1 h-4 w-4 text-accent focus:ring-accent border-line-strong rounded bg-inset"
                />
                <div>
                  <p className="text-sm font-medium text-body">
                    {hasErrors
                      ? t('backup.restore.options.additionalOptions.force')
                      : t('backup.restore.confirmation.acknowledge.label')}
                  </p>
                  <p className="text-xs text-muted">
                    {hasErrors
                      ? t('backup.restore.options.additionalOptions.forceHelp')
                      : t('backup.restore.confirmation.acknowledge.help')}
                  </p>
                </div>
              </label>
              {!forceAllowed && (
                <p className="mt-2 text-xs text-danger-text">
                  {t('backup.restore.confirmation.acknowledge.forceDisabled')}
                </p>
              )}
            </Card>
          )}
        </>
      ) : (
        <div className="text-center py-8">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-accent" />
          <p className="mt-2 text-sm text-soft">{t('backup.restore.confirmation.validation.checking')}</p>
        </div>
      )}
    </div>
  );

  const renderProgress = () => {
    // A tracked run that has ended shows its outcome, even while someone
    // else's restore or dry run is running now; that run's live progress is
    // not this one's.
    const otherRunLive = trackedRunFinished && !!restoreStatus?.isRunning;
    const progress = (otherRunLive ? null : restoreStatus?.currentProgress) || {};
    const isRunning = restoreStatus?.isRunning && !trackedRunFinished;
    // Pull the most recent restore_runs row from history so we can
    // tell whether the "not running" state means success, failure, or
    // never-started. The history endpoint already returns rows newest
    // first. Once this wizard started a run, only that run counts: until its
    // row shows up the newest row is an earlier run, which must not read as
    // this result.
    const lastRun = trackedRun ? trackedRow : restoreStatus?.history?.[0];
    const waitingForRun = !!trackedRun && !isRunning && !lastRun;
    // The data is in place, but its migrations did not run: the backend
    // holds the site in maintenance mode instead of rolling back.
    const lastRunMigrationsPending =
      !isRunning && lastRun && lastRun.status === 'migrations_pending';
    // Stopped by a pre-flight check (validation, warnings, disk space, the
    // safety backup) before anything on this install was changed.
    const lastRunBlocked =
      !isRunning && lastRun && lastRun.status === 'blocked';
    const lastRunFailed =
      !isRunning && lastRun && !lastRunMigrationsPending && !lastRunBlocked
      && (lastRun.status === 'failed' || dbFlagFalse(lastRun.was_successful));
    const lastRunSucceeded =
      !isRunning && lastRun && lastRun.status === 'completed' && dbFlag(lastRun.was_successful);
    // Strip the noisy stack-trace tail from the error message so the
    // user sees the actionable line first.
    const lastRunFirstLine = lastRun?.error_message
      ? lastRun.error_message.split('\n')[0].slice(0, 500)
      : null;
    // A known code reads in the admin's language; what happened to this
    // install afterwards stays in the server's words, since only the message
    // records it (restore_runs has was_rollback_attempted, not its outcome).
    const lastRunCodeText = lastRun?.error_message
      ? backupErrorText(backupErrorCode(lastRun.error_message), t)
      : null;
    const lastRunError = lastRunCodeText ?? lastRunFirstLine;
    const rollbackFailed = !!lastRun?.error_message?.includes('ROLLBACK ALSO FAILED');
    const lastRunOutcome = lastRunCodeText
      ? (lastRun.error_message.match(/ROLLBACK ALSO FAILED:[^\n]*/)
        || lastRun.error_message.match(/no pre-restore backup available[^)\n]*/))?.[0]?.slice(0, 500) ?? null
      : null;
    // The live progress lives in the backend's memory and is reset once the
    // run ends (and after the re-login a restore forces), so a finished run
    // would otherwise read 0%.
    const percentage = lastRunSucceeded ? 100 : (progress.percentage || 0);
    const subtitle = isRunning
      ? t('backup.restore.progress.inProgress')
      : waitingForRun
        ? (trackedRunMissing ? t('backup.restore.progress.notStarted') : t('backup.restore.progress.starting'))
      : lastRunBlocked
        ? t('backup.restore.progress.blockedSubtitle')
        : lastRunFailed && (!dbFlag(lastRun.was_rollback_attempted) || rollbackFailed)
          ? t('backup.restore.progress.failedNotRolledBackSubtitle')
        : lastRunFailed
          ? t('backup.restore.progress.failedSubtitle', 'Restore failed — see error below. Destination has been rolled back to its pre-restore state.')
          : lastRunMigrationsPending
            ? t('backup.restore.progress.migrationsPendingSubtitle', 'Data restored, but database migrations are still pending. The site stays in maintenance mode — see below.')
            : lastRunSucceeded
              ? t('backup.restore.progress.completed')
              : t('backup.restore.progress.idle', 'No restore in progress.');

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold text-heading mb-2">{t('backup.restore.progress.title')}</h3>
          <p className={`text-sm ${
            lastRunFailed
              ? 'text-danger-text font-medium'
              : lastRunMigrationsPending || lastRunBlocked
                ? 'text-warning-text font-medium'
                : 'text-soft'
          }`}>
            {subtitle}
          </p>
        </div>

        {trackedRun?.signedOut && (
          <div className="bg-info-soft border border-info-line rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-info flex-shrink-0 mt-0.5" />
              <p className="text-sm text-info-text">{t('backup.restore.progress.signedOutNote')}</p>
            </div>
          </div>
        )}

        {lastRunFailed && (
          <div className="bg-danger-soft border border-danger-line rounded-lg p-4">
            <div className="flex items-start gap-3">
              <XCircle className="h-5 w-5 text-danger flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-semibold text-danger-text mb-1">
                  {t('backup.restore.progress.errorTitle', 'Restore did not complete')}
                </h4>
                <p className="text-sm text-danger-text font-mono break-all">
                  {lastRunError || t('backup.restore.progress.errorUnknown', 'No error message recorded.')}
                </p>
                {lastRunOutcome && (
                  <p className="mt-2 text-sm text-danger-text font-mono break-all">{lastRunOutcome}</p>
                )}
                {dbFlag(lastRun.was_rollback_attempted) && !rollbackFailed && (
                  <p className="mt-2 text-xs text-danger-text">
                    {t('backup.restore.progress.rolledBack',
                      'Pre-restore safety backup was used to roll back. Destination is in its pre-restore state — safe to retry once the issue above is resolved.')}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {lastRunBlocked && (
          <div className="bg-warning-soft border border-warning-line rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-semibold text-warning-text mb-1">
                  {t('backup.restore.progress.blockedTitle')}
                </h4>
                <p className="text-sm text-warning-text break-words">
                  {lastRunError || t('backup.restore.progress.errorUnknown', 'No error message recorded.')}
                </p>
              </div>
            </div>
          </div>
        )}

        {lastRunMigrationsPending && (
          <div className="bg-warning-soft border border-warning-line rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-semibold text-warning-text mb-1">
                  {t('backup.restore.progress.migrationsPendingTitle', 'Database migrations pending')}
                </h4>
                <p className="text-sm text-warning-text break-words">
                  {lastRunError || t('backup.restore.progress.errorUnknown', 'No error message recorded.')}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Progress Bar */}
        <Card className="p-6">
          <div className="space-y-4">
            <div className="flex justify-between text-sm">
              <span className="text-soft">{t('backup.restore.progress.overallProgress')}</span>
              <span className="font-medium text-heading">{percentage}%</span>
            </div>
            <div className="w-full bg-fill rounded-full h-3">
              <div
                className="bg-accent-strong h-3 rounded-full transition-all duration-500"
                style={{ width: `${percentage}%` }}
              />
            </div>
            {progress.currentFile && (
              <p className="text-sm text-soft">
                {t('backup.restore.progress.current')}: {progress.currentFile}
              </p>
            )}
          </div>
        </Card>

        {/* Status Details */}
        <Card className="p-6">
          <h4 className="font-medium text-heading mb-4">{t('backup.restore.progress.statusDetails')}</h4>
          <div className="space-y-3">
            {progress.steps?.map((step, idx) => (
              <div key={idx} className="flex items-center space-x-3">
                {step.status === 'completed' ? (
                  <CheckCircle className="h-5 w-5 text-success" />
                ) : step.status === 'running' ? (
                  <Loader2 className="h-5 w-5 text-info animate-spin" />
                ) : step.status === 'failed' ? (
                  <XCircle className="h-5 w-5 text-danger" />
                ) : (
                  <Clock className="h-5 w-5 text-neutral-300 dark:text-neutral-600" />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-heading">{step.name}</p>
                  {step.message && (
                    <p className="text-xs text-muted">{step.message}</p>
                  )}
                </div>
                {step.duration && (
                  <span className="text-xs text-muted">{step.duration}</span>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* Logs */}
        {progress.logs && progress.logs.length > 0 && (
          <Card className="p-6">
            <h4 className="font-medium text-heading mb-4">{t('backup.restore.progress.restoreLogs')}</h4>
            <div className="bg-neutral-900 rounded-lg p-4 max-h-64 overflow-y-auto">
              <pre className="text-xs text-neutral-300 font-mono">
                {progress.logs.join('\n')}
              </pre>
            </div>
          </Card>
        )}

        {/* Completion Actions — only when the most recent run actually
            succeeded. Previously this gated on `progress.status` which
            could be null between runs, so the green "Restore completed
            successfully" banner could render alongside a silent failure. */}
        {lastRunSucceeded && (
          <div className="bg-success-soft border border-success-line rounded-lg p-4">
            <div className="flex">
              <CheckCircle className="h-5 w-5 text-success mt-0.5" />
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-success-text">
                  {t('backup.restore.progress.success.title')}
                </h3>
                <p className="mt-1 text-sm text-success-text">
                  {t('backup.restore.progress.success.message')}
                </p>
                {/* Post-restore CTA: jump to the integrity check (D2). The
                    audit trail captured at sign / issue time is worth
                    nothing if the documents it refers to are missing
                    from the restored copy — verifier surfaces that
                    drift in one click before the admin trusts the
                    restored state. */}
                {onVerifyIntegrity && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={onVerifyIntegrity}
                    leftIcon={<ShieldCheck className="w-4 h-4" />}
                  >
                    {t(
                      'backup.restore.progress.success.verifyIntegrity',
                      'Verify document integrity now',
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Progress Steps */}
      <div className="mb-8">
        <nav aria-label="Progress">
          <ol className="flex items-center">
            {steps.map((step, stepIdx) => (
              <li key={step.id} className={`relative ${stepIdx !== steps.length - 1 ? 'pr-8 flex-1' : ''}`}>
                <div className="flex items-center">
                  <div className={`
                    relative flex h-8 w-8 items-center justify-center rounded-full
                    ${currentStep > stepIdx
                      ? 'bg-accent-strong'
                      : currentStep === stepIdx
                      ? 'bg-accent-strong'
                      : 'bg-fill-strong'
                    }
                  `}>
                    {currentStep > stepIdx ? (
                      <CheckCircle className="h-5 w-5 text-accent-fg" />
                    ) : (
                      <span className="text-accent-fg text-sm">{stepIdx + 1}</span>
                    )}
                  </div>
                  {stepIdx !== steps.length - 1 && (
                    <div className={`
                      absolute top-4 w-full h-0.5
                      ${currentStep > stepIdx ? 'bg-accent-strong' : 'bg-fill-strong'}
                    `} style={{ left: '2rem', right: '-2rem' }} />
                  )}
                </div>
                <span className={`
                  mt-2 text-xs font-medium
                  ${currentStep >= stepIdx ? 'text-heading' : 'text-muted'}
                `}>
                  {step.title}
                </span>
              </li>
            ))}
          </ol>
        </nav>
      </div>

      {/* Step Content */}
      <Card className="p-6">
        {currentStep === 0 && renderSourceSelection()}
        {currentStep === 1 && renderBackupSelection()}
        {currentStep === 2 && renderRestoreOptions()}
        {currentStep === 3 && renderConfirmation()}
        {currentStep === 4 && renderProgress()}
      </Card>

      {/* Navigation Buttons */}
      <div className="mt-6 flex justify-between">
        <Button
          variant="secondary"
          onClick={handleBack}
          disabled={currentStep === 0 || currentStep === 4}
        >
          <ChevronLeft className="mr-2 h-4 w-4" />
          {t('backup.restore.actions.back')}
        </Button>

        {currentStep < 4 && (
          <Button
            onClick={handleNext}
            disabled={!canProceed() || validateMutation.isLoading || restoreMutation.isLoading}
          >
            {currentStep === 3 ? (
              <>
                {restoreMutation.isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('backup.restore.actions.starting')}
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('backup.restore.actions.startRestore')}
                  </>
                )}
              </>
            ) : currentStep === 2 ? (
              <>
                {validateMutation.isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('backup.restore.actions.validating')}
                  </>
                ) : (
                  <>
                    {t('backup.restore.actions.next')}
                    <ChevronRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </>
            ) : (
              <>
                {t('backup.restore.actions.next')}
                <ChevronRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        )}

        {currentStep === 4 && !restoreStatus?.isRunning && (
          <Button
            onClick={() => {
              clearRestoreRun();
              setTrackedRun(null);
              setTrackedRunMissing(false);
              setCurrentStep(0);
              setRestoreData({
                source: null,
                sourceConfig: {},
                selectedBackup: null,
                restoreType: 'full',
                selectedItems: [],
                skipPreBackup: false,
                force: false
              });
              setValidationResult(null);
            }}
          >
            {t('backup.restore.actions.startNewRestore')}
          </Button>
        )}
      </div>
    </div>
  );
};