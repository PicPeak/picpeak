import React, { useState } from 'react';
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
  Shield,
  Download,
  Eye,
  Calendar,
  Clock,
  AlertCircle,
  ShieldCheck
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button, Card, Input, Loading } from '../common';
import { api } from '../../config/api';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

export const RestoreWizard = ({ onVerifyIntegrity } = {}) => {
  const { t } = useTranslation();
  const { format: fmtDate, formatTime: fmtTime, formatDateTime: fmtDateTime } = useLocalizedDate();
  const [currentStep, setCurrentStep] = useState(0);
  
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
    force: false,
    encryptionPassphrase: ''
  });
  const [validationResult, setValidationResult] = useState(null);

  // Fetch restore status
  const { data: restoreStatus } = useQuery({
    queryKey: ['restore-status'],
    queryFn: async () => {
      const response = await api.get('/admin/restore/status');
      return response.data.data;
    },
    refetchInterval: currentStep === 4 ? 2000 : false // Poll during restore
  });

  // Fetch available backups
  const { data: availableBackups, isLoading: loadingBackups } = useQuery({
    queryKey: ['available-backups', restoreData.source, restoreData.sourceConfig],
    queryFn: async () => {
      const response = await api.post('/admin/restore/list-backups', {
        source: restoreData.source,
        ...restoreData.sourceConfig
      });
      return response.data.data;
    },
    enabled: currentStep === 1 && !!restoreData.source
  });

  // Validate restore
  const validateMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/admin/restore/validate', {
        source: restoreData.source,
        manifestPath: restoreData.selectedBackup.manifest_path,
        restoreType: restoreData.restoreType,
        selectedItems: restoreData.selectedItems,
        ...restoreData.sourceConfig
      });
      return response.data.data;
    },
    onSuccess: (data) => {
      setValidationResult(data);
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
        source: restoreData.source,
        manifestPath: restoreData.selectedBackup.manifest_path,
        restoreType: restoreData.restoreType,
        selectedItems: restoreData.selectedItems,
        skipPreBackup: restoreData.skipPreBackup,
        force: restoreData.force,
        encryptionPassphrase: restoreData.encryptionPassphrase,
        ...restoreData.sourceConfig
      });
      return response.data;
    },
    onSuccess: () => {
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

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return !!restoreData.source;
      case 1:
        return !!restoreData.selectedBackup;
      case 2:
        return !!restoreData.restoreType;
      case 3:
        return !!validationResult && !validateMutation.isLoading;
      default:
        return false;
    }
  };

  // Step Components
  const renderSourceSelection = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('backup.restore.source.title')}</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('backup.restore.source.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button
          onClick={() => setRestoreData(prev => ({ ...prev, source: 'local' }))}
          className={`p-6 rounded-lg border-2 transition-all ${
            restoreData.source === 'local'
              ? 'border-primary bg-accent-dark/15'
              : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
          }`}
        >
          <HardDrive className={`h-12 w-12 mb-3 mx-auto ${
            restoreData.source === 'local' ? 'text-primary' : 'text-neutral-400'
          }`} />
          <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.restore.source.local.name')}</h4>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('backup.restore.source.local.description')}</p>
        </button>

        <button
          onClick={() => setRestoreData(prev => ({ ...prev, source: 's3' }))}
          className={`p-6 rounded-lg border-2 transition-all ${
            restoreData.source === 's3'
              ? 'border-primary bg-accent-dark/15'
              : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
          }`}
        >
          <Cloud className={`h-12 w-12 mb-3 mx-auto ${
            restoreData.source === 's3' ? 'text-primary' : 'text-neutral-400'
          }`} />
          <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.restore.source.s3.name')}</h4>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('backup.restore.source.s3.description')}</p>
        </button>

        <button
          onClick={() => setRestoreData(prev => ({ ...prev, source: 'upload' }))}
          className={`p-6 rounded-lg border-2 transition-all ${
            restoreData.source === 'upload'
              ? 'border-primary bg-accent-dark/15'
              : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
          }`}
        >
          <Upload className={`h-12 w-12 mb-3 mx-auto ${
            restoreData.source === 'upload' ? 'text-primary' : 'text-neutral-400'
          }`} />
          <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.restore.source.upload.name')}</h4>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('backup.restore.source.upload.description')}</p>
        </button>
      </div>

      {/* Source-specific configuration */}
      {restoreData.source === 's3' && (
        <Card className="p-4 space-y-4">
          <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.restore.source.configuration.s3')}</h4>
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
                  ? 'border-primary bg-accent-dark/15'
                  : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
              }`}
            >
              <FileArchive className={`h-10 w-10 mb-2 mx-auto ${restoreData.uploadType === 'picpeak' ? 'text-primary' : 'text-neutral-400'}`} />
              <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.restore.source.upload.picpeak.name', '.picpeak backup')}</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('backup.restore.source.upload.picpeak.description', 'Portable full backup — restores everything (full override, keeps your current account).')}</p>
            </button>
            <button
              onClick={() => setRestoreData(prev => ({ ...prev, uploadType: 'manifest' }))}
              className={`p-6 rounded-lg border-2 transition-all ${
                restoreData.uploadType === 'manifest'
                  ? 'border-primary bg-accent-dark/15'
                  : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
              }`}
            >
              <Upload className={`h-10 w-10 mb-2 mx-auto ${restoreData.uploadType === 'manifest' ? 'text-primary' : 'text-neutral-400'}`} />
              <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.restore.source.upload.manifest.name', 'Manifest + files')}</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('backup.restore.source.upload.manifest.description', 'Upload a manifest and its backup files (legacy format).')}</p>
            </button>
          </div>

          {restoreData.uploadType === 'picpeak' && <PicpeakRestoreCard />}

          {restoreData.uploadType === 'manifest' && (
            <Card className="p-4">
              <div className="text-center py-8">
                <Upload className="h-12 w-12 mx-auto mb-3 text-neutral-400" />
                <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('backup.restore.source.upload.manifestComingSoon', 'Manifest Upload functionality coming soon')}</p>
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
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('backup.restore.backup.title')}</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('backup.restore.backup.subtitle')}</p>
      </div>

      {loadingBackups ? (
        <Loading />
      ) : availableBackups?.length === 0 ? (
        <Card className="p-8 text-center">
          <FileArchive className="h-12 w-12 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
          <p className="text-neutral-500 dark:text-neutral-400">{t('backup.restore.backup.noBackupsFound')}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {availableBackups?.map((backup) => (
            <Card
              key={backup.id}
              className={`p-4 cursor-pointer transition-all ${
                restoreData.selectedBackup?.id === backup.id
                  ? 'ring-2 ring-primary bg-accent-dark/15'
                  : 'hover:shadow-md'
              }`}
              onClick={() => setRestoreData(prev => ({ ...prev, selectedBackup: backup }))}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className={`p-2 rounded-lg ${
                    backup.status === 'completed' ? 'bg-green-100 dark:bg-green-900/40' : 'bg-amber-100 dark:bg-amber-900/40'
                  }`}>
                    {backup.status === 'completed' ? (
                      <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                    ) : (
                      <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">
                      {fmtDate(backup.created_at)} {t('backup.restore.backup.at')} {fmtTime(backup.created_at)}
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      {t('backup.dashboard.backupType', { type: backup.backup_type })} • {formatBytes(backup.total_size || 0)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {/* Files-only warning — backend's /list-backups now
                      returns `database_included: boolean` parsed from
                      the manifest's database.backup_file field. A row
                      where this is false is exactly the data-loss
                      scenario the Stage A guard prevents going forward:
                      a manifest written without an inline DB dump.
                      Restoring it would NOT bring CRM data back. */}
                  {backup.database_included === false && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700"
                      title={t('backup.restore.backup.filesOnlyHint',
                        'This backup has no database dump — restoring it will NOT recover the database (CRM data, customers, quotes, invoices, contracts will be empty after restore).')}
                    >
                      <AlertCircle className="h-3 w-3" />
                      {t('backup.restore.backup.filesOnlyBadge', 'No DB')}
                    </span>
                  )}
                  {backup.corrupt && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700"
                      title={t('backup.restore.backup.corruptHint',
                        'The manifest file is unreadable — the backup may be incomplete or damaged.')}
                    >
                      <AlertCircle className="h-3 w-3" />
                      {t('backup.restore.backup.corruptBadge', 'Corrupt')}
                    </span>
                  )}
                  {backup.encrypted && (
                    <Shield className="h-5 w-5 text-neutral-400" />
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
        <Card className="p-4 bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700">
          <div className="flex items-start space-x-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-800 dark:text-red-200">
                {t('backup.restore.backup.filesOnlyWarning.title',
                  'Selected backup has no database dump')}
              </p>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300">
                {t('backup.restore.backup.filesOnlyWarning.message',
                  'Restoring this backup will recover files (photos, PDFs) but the database — including admin users, customers, quotes, invoices, contracts, and settings — will NOT come back. Pick a different backup if you have one with a database dump, or proceed only if files-only is what you want.')}
              </p>
            </div>
          </div>
        </Card>
      )}

      {restoreData.selectedBackup?.encrypted && (
        <Card className="p-4 bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800">
          <div className="flex items-start space-x-3">
            <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t('backup.restore.backup.encrypted')}</p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                {t('backup.restore.backup.encryptedMessage')}
              </p>
              <Input
                type="password"
                placeholder={t('backup.restore.backup.enterPassphrase')}
                className="mt-3"
                value={restoreData.encryptionPassphrase}
                onChange={(e) => setRestoreData(prev => ({
                  ...prev,
                  encryptionPassphrase: e.target.value
                }))}
              />
            </div>
          </div>
        </Card>
      )}
    </div>
  );

  const renderRestoreOptions = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('backup.restore.options.title')}</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('backup.restore.options.subtitle')}</p>
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
                  ? 'border-primary bg-accent-dark/15'
                  : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
              }`}
            >
              <div className="flex items-start space-x-3">
                <Icon className={`h-6 w-6 mt-1 ${
                  restoreData.restoreType === type.id ? 'text-primary' : 'text-neutral-400'
                }`} />
                <div className="flex-1">
                  <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{type.name}</h4>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{type.description}</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
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
        <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.restore.options.additionalOptions.title')}</h4>

        <label className="flex items-start space-x-3">
          <input
            type="checkbox"
            checked={restoreData.skipPreBackup}
            onChange={(e) => setRestoreData(prev => ({
              ...prev,
              skipPreBackup: e.target.checked
            }))}
            className="mt-1 h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
          />
          <div>
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.restore.options.additionalOptions.skipPreBackup')}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('backup.restore.options.additionalOptions.skipPreBackupHelp')}
            </p>
          </div>
        </label>

        <label className="flex items-start space-x-3">
          <input
            type="checkbox"
            checked={restoreData.force}
            onChange={(e) => setRestoreData(prev => ({
              ...prev,
              force: e.target.checked
            }))}
            className="mt-1 h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
          />
          <div>
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.restore.options.additionalOptions.force')}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('backup.restore.options.additionalOptions.forceHelp')}
            </p>
          </div>
        </label>
      </Card>
    </div>
  );

  const renderConfirmation = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('backup.restore.confirmation.title')}</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.subtitle')}</p>
      </div>

      {validationResult ? (
        <>
          {/* Validation Results */}
          <Card className={`p-4 ${
            validationResult.validation?.isValid
              ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800'
          }`}>
            <div className="flex items-start space-x-3">
              {validationResult.validation?.isValid ? (
                <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
              ) : (
                <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
              )}
              <div className="flex-1">
                <p className={`text-sm font-medium ${
                  validationResult.validation?.isValid ? 'text-green-900 dark:text-green-200' : 'text-red-900 dark:text-red-200'
                }`}>
                  {validationResult.validation?.isValid 
                    ? t('backup.restore.confirmation.validation.passed') 
                    : t('backup.restore.confirmation.validation.failed')}
                </p>
                {validationResult.validation?.errors?.length > 0 && (
                  <ul className="mt-2 text-sm text-red-700 dark:text-red-300 list-disc list-inside">
                    {validationResult.validation.errors.map((error, idx) => (
                      <li key={idx}>{error}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          {/* Space Check */}
          {validationResult.spaceCheck && (
            <Card className="p-4">
              <h4 className="font-medium text-neutral-900 dark:text-neutral-100 mb-3">{t('backup.restore.confirmation.spaceCheck.title')}</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.spaceCheck.required')}:</span>
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                    {validationResult.spaceCheck.requiredFormatted || formatBytes(validationResult.spaceCheck.required || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.spaceCheck.available')}:</span>
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                    {validationResult.spaceCheck.availableFormatted ||
                     (validationResult.spaceCheck.available != null ? formatBytes(validationResult.spaceCheck.available) : t('common.unknown', 'Unknown'))}
                  </span>
                </div>
                {validationResult.spaceCheck.sufficient === false && (
                  <p className="text-red-600 text-xs mt-2">
                    <AlertCircle className="inline h-3 w-3 mr-1" />
                    {t('backup.restore.confirmation.spaceCheck.insufficient')}
                  </p>
                )}
              </div>
            </Card>
          )}

          {/* Summary */}
          <Card className="p-4">
            <h4 className="font-medium text-neutral-900 dark:text-neutral-100 mb-3">{t('backup.restore.confirmation.summary.title')}</h4>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.summary.source')}:</dt>
                <dd className="font-medium text-neutral-900 dark:text-neutral-100 capitalize">{restoreData.source}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.summary.backupDate')}:</dt>
                <dd className="font-medium text-neutral-900 dark:text-neutral-100">
                  {fmtDateTime(restoreData.selectedBackup.created_at)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.summary.restoreType')}:</dt>
                <dd className="font-medium text-neutral-900 dark:text-neutral-100 capitalize">{restoreData.restoreType}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.summary.preBackup')}:</dt>
                <dd className="font-medium text-neutral-900 dark:text-neutral-100">{restoreData.skipPreBackup ? t('backup.restore.confirmation.summary.skipped') : t('backup.restore.confirmation.summary.enabled')}</dd>
              </div>
            </dl>
          </Card>

          {/* Warning */}
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
            <div className="flex">
              <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5" />
              <div className="ml-3">
                <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  {t('backup.restore.confirmation.warning.title')}
                </h3>
                <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                  {t('backup.restore.confirmation.warning.message')}
                </p>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-8">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{t('backup.restore.confirmation.validation.checking')}</p>
        </div>
      )}
    </div>
  );

  const renderProgress = () => {
    const progress = restoreStatus?.currentProgress || {};
    const isRunning = restoreStatus?.isRunning;
    // Pull the most recent restore_runs row from history so we can
    // tell whether the "not running" state means success, failure, or
    // never-started. The history endpoint already returns rows newest
    // first.
    const lastRun = restoreStatus?.history?.[0];
    const lastRunFailed =
      !isRunning && lastRun && (lastRun.status === 'failed' || lastRun.was_successful === false);
    const lastRunSucceeded =
      !isRunning && lastRun && lastRun.status === 'completed' && lastRun.was_successful === true;
    // Strip the noisy stack-trace tail from the error message so the
    // user sees the actionable line first.
    const lastRunError = lastRun?.error_message
      ? lastRun.error_message.split('\n')[0].slice(0, 500)
      : null;
    const subtitle = isRunning
      ? t('backup.restore.progress.inProgress')
      : lastRunFailed
        ? t('backup.restore.progress.failedSubtitle', 'Restore failed — see error below. Destination has been rolled back to its pre-restore state.')
        : lastRunSucceeded
          ? t('backup.restore.progress.completed')
          : t('backup.restore.progress.idle', 'No restore in progress.');

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('backup.restore.progress.title')}</h3>
          <p className={`text-sm ${
            lastRunFailed
              ? 'text-red-700 dark:text-red-300 font-medium'
              : 'text-neutral-600 dark:text-neutral-400'
          }`}>
            {subtitle}
          </p>
        </div>

        {lastRunFailed && (
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-semibold text-red-800 dark:text-red-200 mb-1">
                  {t('backup.restore.progress.errorTitle', 'Restore did not complete')}
                </h4>
                <p className="text-sm text-red-700 dark:text-red-300 font-mono break-all">
                  {lastRunError || t('backup.restore.progress.errorUnknown', 'No error message recorded.')}
                </p>
                {lastRun.was_rollback_attempted && (
                  <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {t('backup.restore.progress.rolledBack',
                      'Pre-restore safety backup was used to roll back. Destination is in its pre-restore state — safe to retry once the issue above is resolved.')}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Progress Bar */}
        <Card className="p-6">
          <div className="space-y-4">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-600 dark:text-neutral-400">{t('backup.restore.progress.overallProgress')}</span>
              <span className="font-medium text-neutral-900 dark:text-neutral-100">{progress.percentage || 0}%</span>
            </div>
            <div className="w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-3">
              <div
                className="bg-primary h-3 rounded-full transition-all duration-500"
                style={{ width: `${progress.percentage || 0}%` }}
              />
            </div>
            {progress.currentFile && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('backup.restore.progress.current')}: {progress.currentFile}
              </p>
            )}
          </div>
        </Card>

        {/* Status Details */}
        <Card className="p-6">
          <h4 className="font-medium text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.restore.progress.statusDetails')}</h4>
          <div className="space-y-3">
            {progress.steps?.map((step, idx) => (
              <div key={idx} className="flex items-center space-x-3">
                {step.status === 'completed' ? (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                ) : step.status === 'running' ? (
                  <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
                ) : step.status === 'failed' ? (
                  <XCircle className="h-5 w-5 text-red-500" />
                ) : (
                  <Clock className="h-5 w-5 text-neutral-300 dark:text-neutral-600" />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{step.name}</p>
                  {step.message && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{step.message}</p>
                  )}
                </div>
                {step.duration && (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">{step.duration}</span>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* Logs */}
        {progress.logs && progress.logs.length > 0 && (
          <Card className="p-6">
            <h4 className="font-medium text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.restore.progress.restoreLogs')}</h4>
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
          <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <div className="flex">
              <CheckCircle className="h-5 w-5 text-green-400 mt-0.5" />
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-green-800 dark:text-green-200">
                  {t('backup.restore.progress.success.title')}
                </h3>
                <p className="mt-1 text-sm text-green-700 dark:text-green-300">
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
                      ? 'bg-primary'
                      : currentStep === stepIdx
                      ? 'bg-primary'
                      : 'bg-neutral-300 dark:bg-neutral-600'
                    }
                  `}>
                    {currentStep > stepIdx ? (
                      <CheckCircle className="h-5 w-5 text-white" />
                    ) : (
                      <span className="text-white text-sm">{stepIdx + 1}</span>
                    )}
                  </div>
                  {stepIdx !== steps.length - 1 && (
                    <div className={`
                      absolute top-4 w-full h-0.5
                      ${currentStep > stepIdx ? 'bg-primary' : 'bg-neutral-300 dark:bg-neutral-600'}
                    `} style={{ left: '2rem', right: '-2rem' }} />
                  )}
                </div>
                <span className={`
                  mt-2 text-xs font-medium
                  ${currentStep >= stepIdx ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400'}
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
              setCurrentStep(0);
              setRestoreData({
                source: null,
                sourceConfig: {},
                selectedBackup: null,
                restoreType: 'full',
                selectedItems: [],
                skipPreBackup: false,
                force: false,
                encryptionPassphrase: ''
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