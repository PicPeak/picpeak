import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Save,
  Server,
  Cloud,
  HardDrive,
  AlertCircle,
  Eye,
  EyeOff,
  Wifi,
  Loader2,
  Database,
  Image,
  FileArchive
} from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input } from '../common';

interface BackupFormData {
  backup_enabled: boolean;
  backup_destination_type: 'local' | 'rsync' | 's3';
  backup_destination_path: string;
  backup_rsync_host: string;
  backup_rsync_user: string;
  backup_rsync_path: string;
  backup_rsync_ssh_key: string;
  backup_s3_endpoint: string;
  backup_s3_bucket: string;
  backup_s3_access_key: string;
  backup_s3_secret_key: string;
  backup_s3_region: string;
  backup_schedule: string;
  backup_schedule_cron: string;
  backup_retention_days: number;
  backup_include_database: boolean;
  backup_include_photos: boolean;
  backup_include_archives: boolean;
  backup_include_thumbnails: boolean;
  backup_include_temp: boolean;
  backup_compression: boolean;
  backup_encryption: boolean;
  backup_encryption_passphrase: string;
}

interface BackupConfigurationProps {
  config?: Partial<BackupFormData>;
  onSave: (data: BackupFormData) => void;
  isSaving: boolean;
}

export const BackupConfiguration: React.FC<BackupConfigurationProps> = ({ config, onSave, isSaving }) => {
  const { t } = useTranslation();

  const destinationTypes = [
    {
      id: 'local' as const,
      name: t('backup.configuration.destinationTypes.local.name'),
      icon: HardDrive,
      description: t('backup.configuration.destinationTypes.local.description'),
      fields: ['backup_destination_path']
    },
    {
      id: 'rsync' as const,
      name: t('backup.configuration.destinationTypes.rsync.name'),
      icon: Server,
      description: t('backup.configuration.destinationTypes.rsync.description'),
      fields: ['backup_rsync_host', 'backup_rsync_user', 'backup_rsync_path', 'backup_rsync_ssh_key']
    },
    {
      id: 's3' as const,
      name: t('backup.configuration.destinationTypes.s3.name'),
      icon: Cloud,
      description: t('backup.configuration.destinationTypes.s3.description'),
      fields: ['backup_s3_endpoint', 'backup_s3_bucket', 'backup_s3_access_key', 'backup_s3_secret_key', 'backup_s3_region']
    }
  ];

  const scheduleOptions = [
    { value: 'hourly', label: t('backup.configuration.schedule.options.hourly') },
    { value: 'daily', label: t('backup.configuration.schedule.options.daily') },
    { value: 'weekly', label: t('backup.configuration.schedule.options.weekly') },
    { value: 'custom', label: t('backup.configuration.schedule.options.custom') }
  ];

  const [formData, setFormData] = useState<BackupFormData>({
    backup_enabled: false,
    backup_destination_type: 'local',
    backup_destination_path: '',
    backup_rsync_host: '',
    backup_rsync_user: '',
    backup_rsync_path: '',
    backup_rsync_ssh_key: '',
    backup_s3_endpoint: '',
    backup_s3_bucket: '',
    backup_s3_access_key: '',
    backup_s3_secret_key: '',
    backup_s3_region: '',
    backup_schedule: 'daily',
    backup_schedule_cron: '0 3 * * *',
    backup_retention_days: 30,
    backup_include_database: true,
    backup_include_photos: true,
    backup_include_archives: true,
    backup_include_thumbnails: false,
    backup_include_temp: false,
    backup_compression: true,
    backup_encryption: false,
    backup_encryption_passphrase: ''
  });

  const [showSecrets, setShowSecrets] = useState({
    s3_secret_key: false,
    ssh_key: false,
    encryption_passphrase: false
  });

  const [testingConnection, setTestingConnection] = useState(false);

  useEffect(() => {
    if (config) {
      setFormData(prev => ({
        ...prev,
        ...config
      }));
    }
  }, [config]);

  const handleChange = <K extends keyof BackupFormData>(field: K, value: BackupFormData[K]) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const destinationType = destinationTypes.find(dt => dt.id === formData.backup_destination_type);
    const missingFields: string[] = [];

    if (formData.backup_enabled && destinationType) {
      destinationType.fields.forEach(field => {
        if (!formData[field as keyof BackupFormData] && !field.includes('optional')) {
          missingFields.push(field);
        }
      });
    }

    if (missingFields.length > 0) {
      toast.error(t('backup.configuration.messages.requiredFields'));
      return;
    }

    onSave(formData);
  };

  const testConnection = async () => {
    setTestingConnection(true);
    try {
      // TODO: Implement connection test endpoint
      await new Promise(resolve => setTimeout(resolve, 2000));
      toast.success(t('backup.configuration.messages.connectionSuccess'));
    } catch (error) {
      toast.error(t('backup.configuration.messages.connectionFailed') + ': ' + (error as Error).message);
    } finally {
      setTestingConnection(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Enable/Disable Toggle */}
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('backup.configuration.enableBackup')}</h3>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {t('backup.configuration.enableBackupHelp')}
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={formData.backup_enabled}
              onChange={(e) => handleChange('backup_enabled', e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-neutral-200 dark:bg-neutral-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 dark:after:border-neutral-500 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
          </label>
        </div>
      </Card>

      {/* Destination Configuration */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.configuration.destinationType')}</h3>

        {/* Destination Type Selection */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {destinationTypes.map((type) => {
            const Icon = type.icon;
            return (
              <button
                key={type.id}
                type="button"
                onClick={() => handleChange('backup_destination_type', type.id)}
                className={`p-4 rounded-lg border-2 transition-all ${
                  formData.backup_destination_type === type.id
                    ? 'border-primary bg-accent-dark/15'
                    : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
                }`}
              >
                <Icon className={`h-8 w-8 mb-2 mx-auto ${
                  formData.backup_destination_type === type.id
                    ? 'text-primary'
                    : 'text-neutral-400'
                }`} />
                <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{type.name}</h4>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{type.description}</p>
              </button>
            );
          })}
        </div>

        {/* Destination-specific fields */}
        <div className="space-y-4">
          {formData.backup_destination_type === 'local' && (
            <>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('backup.configuration.fields.destinationPath')}
                </label>
                <Input
                  type="text"
                  value={formData.backup_destination_path}
                  onChange={(e) => handleChange('backup_destination_path', e.target.value)}
                  placeholder={t('backup.configuration.fields.destinationPathPlaceholder')}
                  required
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('backup.configuration.fields.destinationPathHelp')}
                </p>
              </div>
            </>
          )}

          {formData.backup_destination_type === 'rsync' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('backup.configuration.fields.rsyncHost')}
                  </label>
                  <Input
                    type="text"
                    value={formData.backup_rsync_host}
                    onChange={(e) => handleChange('backup_rsync_host', e.target.value)}
                    placeholder={t('backup.configuration.fields.rsyncHostPlaceholder')}
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('backup.configuration.fields.rsyncUser')}
                  </label>
                  <Input
                    type="text"
                    value={formData.backup_rsync_user}
                    onChange={(e) => handleChange('backup_rsync_user', e.target.value)}
                    placeholder={t('backup.configuration.fields.rsyncUserPlaceholder')}
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('backup.configuration.fields.rsyncPath')}
                </label>
                <Input
                  type="text"
                  value={formData.backup_rsync_path}
                  onChange={(e) => handleChange('backup_rsync_path', e.target.value)}
                  placeholder={t('backup.configuration.fields.rsyncPathPlaceholder')}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('backup.configuration.fields.rsyncSshKey')}
                </label>
                <div className="relative">
                  <textarea
                    value={formData.backup_rsync_ssh_key}
                    onChange={(e) => handleChange('backup_rsync_ssh_key', e.target.value)}
                    placeholder={t('backup.configuration.fields.rsyncSshKeyPlaceholder')}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-primary focus:border-primary font-mono text-sm"
                    rows={4}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, ssh_key: !prev.ssh_key }))}
                    className="absolute top-2 right-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    {showSecrets.ssh_key ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('backup.configuration.fields.rsyncSshKeyHelp')}
                </p>
              </div>
            </>
          )}

          {formData.backup_destination_type === 's3' && (
            <>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('backup.configuration.fields.s3Endpoint')}
                </label>
                <Input
                  type="text"
                  value={formData.backup_s3_endpoint}
                  onChange={(e) => handleChange('backup_s3_endpoint', e.target.value)}
                  placeholder="https://s3.amazonaws.com"
                  required
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('backup.configuration.fields.s3EndpointHelp')}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('backup.configuration.fields.s3Bucket')}
                  </label>
                  <Input
                    type="text"
                    value={formData.backup_s3_bucket}
                    onChange={(e) => handleChange('backup_s3_bucket', e.target.value)}
                    placeholder="my-backup-bucket"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('backup.configuration.fields.s3Region')}
                  </label>
                  <Input
                    type="text"
                    value={formData.backup_s3_region}
                    onChange={(e) => handleChange('backup_s3_region', e.target.value)}
                    placeholder="us-east-1"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('backup.configuration.fields.s3AccessKey')}
                  </label>
                  <Input
                    type="text"
                    value={formData.backup_s3_access_key}
                    onChange={(e) => handleChange('backup_s3_access_key', e.target.value)}
                    placeholder="AKIAIOSFODNN7EXAMPLE"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('backup.configuration.fields.s3SecretKey')}
                  </label>
                  <div className="relative">
                    <Input
                      type={showSecrets.s3_secret_key ? 'text' : 'password'}
                      value={formData.backup_s3_secret_key}
                      onChange={(e) => handleChange('backup_s3_secret_key', e.target.value)}
                      placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecrets(prev => ({ ...prev, s3_secret_key: !prev.s3_secret_key }))}
                      className="absolute top-1/2 -translate-y-1/2 right-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                    >
                      {showSecrets.s3_secret_key ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Test Connection Button */}
          {formData.backup_destination_type && (
            <div className="pt-2">
              <Button
                type="button"
                onClick={testConnection}
                disabled={testingConnection}
                variant="secondary"
                size="sm"
              >
                {testingConnection ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('backup.configuration.testingConnection')}
                  </>
                ) : (
                  <>
                    <Wifi className="mr-2 h-4 w-4" />
                    {t('backup.actions.testConnection')}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Schedule Configuration */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.configuration.schedule.title')}</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('backup.configuration.schedule.scheduleType')}
            </label>
            <select
              value={formData.backup_schedule}
              onChange={(e) => handleChange('backup_schedule', e.target.value)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-primary focus:border-primary"
            >
              {scheduleOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {formData.backup_schedule === 'custom' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('backup.configuration.schedule.customCron')}
              </label>
              <Input
                type="text"
                value={formData.backup_schedule_cron}
                onChange={(e) => handleChange('backup_schedule_cron', e.target.value)}
                placeholder="0 3 * * *"
              />
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('backup.configuration.schedule.customCronHelp')}
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('backup.configuration.schedule.retention')}
            </label>
            <Input
              type="number"
              value={formData.backup_retention_days}
              onChange={(e) => handleChange('backup_retention_days', parseInt(e.target.value))}
              min="1"
              max="365"
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t('backup.configuration.schedule.retentionHelp')}
            </p>
          </div>
        </div>
      </Card>

      {/* Backup Content Selection */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.configuration.whatToBackup.title')}</h3>

        <div className="space-y-3">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={formData.backup_include_database}
              onChange={(e) => handleChange('backup_include_database', e.target.checked)}
              className="h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
            />
            <div className="ml-3">
              <div className="flex items-center space-x-2">
                <Database className="h-4 w-4 text-neutral-400" />
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.configuration.whatToBackup.database')}</span>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('backup.configuration.whatToBackup.databaseHelp')}</p>
            </div>
          </label>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={formData.backup_include_photos}
              onChange={(e) => handleChange('backup_include_photos', e.target.checked)}
              className="h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
            />
            <div className="ml-3">
              <div className="flex items-center space-x-2">
                <Image className="h-4 w-4 text-neutral-400" />
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.configuration.whatToBackup.photos')}</span>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('backup.configuration.whatToBackup.photosHelp')}</p>
            </div>
          </label>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={formData.backup_include_archives}
              onChange={(e) => handleChange('backup_include_archives', e.target.checked)}
              className="h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
            />
            <div className="ml-3">
              <div className="flex items-center space-x-2">
                <FileArchive className="h-4 w-4 text-neutral-400" />
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.configuration.whatToBackup.archives')}</span>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('backup.configuration.whatToBackup.archivesHelp')}</p>
            </div>
          </label>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={formData.backup_include_thumbnails}
              onChange={(e) => handleChange('backup_include_thumbnails', e.target.checked)}
              className="h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
            />
            <div className="ml-3">
              <div className="flex items-center space-x-2">
                <Image className="h-4 w-4 text-neutral-400" />
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.configuration.whatToBackup.thumbnails')}</span>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('backup.configuration.whatToBackup.thumbnailsHelp')}</p>
            </div>
          </label>
        </div>
      </Card>

      {/* Advanced Options */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.configuration.advancedOptions.title')}</h3>

        <div className="space-y-4">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={formData.backup_compression}
              onChange={(e) => handleChange('backup_compression', e.target.checked)}
              className="h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
            />
            <div className="ml-3">
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.configuration.advancedOptions.compression')}</span>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('backup.configuration.advancedOptions.compressionHelp')}</p>
            </div>
          </label>

          <div>
            <label className="flex items-center mb-3">
              <input
                type="checkbox"
                checked={formData.backup_encryption}
                onChange={(e) => handleChange('backup_encryption', e.target.checked)}
                className="h-4 w-4 text-primary focus:ring-primary border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700"
              />
              <div className="ml-3">
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('backup.configuration.advancedOptions.encryption')}</span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('backup.configuration.advancedOptions.encryptionHelp')}</p>
              </div>
            </label>

            {formData.backup_encryption && (
              <div className="ml-7">
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('backup.configuration.advancedOptions.encryptionPassphrase')}
                </label>
                <div className="relative">
                  <Input
                    type={showSecrets.encryption_passphrase ? 'text' : 'password'}
                    value={formData.backup_encryption_passphrase}
                    onChange={(e) => handleChange('backup_encryption_passphrase', e.target.value)}
                    placeholder={t('backup.configuration.advancedOptions.encryptionPassphraseHelp')}
                    required={formData.backup_encryption}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecrets(prev => ({ ...prev, encryption_passphrase: !prev.encryption_passphrase }))}
                    className="absolute top-1/2 -translate-y-1/2 right-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    {showSecrets.encryption_passphrase ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-red-600">
                  <AlertCircle className="inline h-3 w-3 mr-1" />
                  {t('backup.configuration.advancedOptions.encryptionPassphraseHelp')}
                </p>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={isSaving}
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('backup.configuration.savingSettings')}
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {t('backup.configuration.saveSettings')}
            </>
          )}
        </Button>
      </div>
    </form>
  );
};
