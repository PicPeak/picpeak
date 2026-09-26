import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, Mail, Send, RefreshCw } from 'lucide-react';
import { Card, Button, Input } from '../../../components/common';
import { api } from '../../../config/api';
import { toast } from 'react-toastify';

interface UpdateNotificationSettingsData {
  enabled: boolean;
  recipients: string;
  lastNotifiedVersion: string;
}

async function fetchNotificationSettings(): Promise<UpdateNotificationSettingsData> {
  const response = await api.get<UpdateNotificationSettingsData>('/admin/system/updates/notifications');
  return response.data;
}

async function updateNotificationSettings(data: Partial<UpdateNotificationSettingsData>): Promise<UpdateNotificationSettingsData> {
  const response = await api.put<{ success: boolean; settings: UpdateNotificationSettingsData }>(
    '/admin/system/updates/notifications',
    data
  );
  return response.data.settings;
}

async function sendTestNotification(): Promise<{ success: boolean; message?: string; successCount?: number }> {
  const response = await api.post('/admin/system/updates/notifications/send');
  return response.data;
}

async function checkForNotifications(): Promise<{ notified: boolean; reason?: string }> {
  const response = await api.post('/admin/system/updates/notifications/check');
  return response.data;
}

export interface SettingsFormState {
  isDirty: boolean;
  isSaving: boolean;
  save: () => void;
  discard: () => void;
}

interface UpdateNotificationSettingsProps {
  /** Reports dirty/save/discard to the host, which renders the one save bar. */
  onFormState?: (state: SettingsFormState) => void;
}

export const UpdateNotificationSettings: React.FC<UpdateNotificationSettingsProps> = ({ onFormState }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['update-notification-settings'],
    queryFn: fetchNotificationSettings
  });

  const [localEnabled, setLocalEnabled] = React.useState<boolean>(false);
  const [localRecipients, setLocalRecipients] = React.useState<string>('');
  // Dirty is a comparison against the server copy, so an edit back to the
  // stored value reads clean and a save (setQueryData) clears it by itself.
  const isDirty = !!settings && (localEnabled !== settings.enabled || localRecipients !== (settings.recipients || ''));

  // Sync local state when data is loaded
  React.useEffect(() => {
    if (settings && !isDirty) {
      setLocalEnabled(settings.enabled);
      setLocalRecipients(settings.recipients || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: updateNotificationSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(['update-notification-settings'], data);
      toast.success(t('settings.updateNotifications.saved', 'Settings saved'));
    },
    onError: () => {
      toast.error(t('settings.updateNotifications.saveError', 'Failed to save settings'));
    }
  });

  const sendMutation = useMutation({
    mutationFn: sendTestNotification,
    onSuccess: (data) => {
      if (data.success) {
        toast.success(
          t('settings.updateNotifications.emailSent', 'Notification email sent to {{count}} recipients', {
            count: data.successCount || 0
          })
        );
      } else {
        toast.error(data.message || t('settings.updateNotifications.emailFailed', 'Failed to send notification'));
      }
    },
    onError: () => {
      toast.error(t('settings.updateNotifications.emailFailed', 'Failed to send notification'));
    }
  });

  const checkMutation = useMutation({
    mutationFn: checkForNotifications,
    onSuccess: (data) => {
      if (data.notified) {
        toast.success(t('settings.updateNotifications.checkSuccess', 'Notification sent for new version'));
      } else {
        toast.success(
          t('settings.updateNotifications.checkNoAction', 'No notification needed: {{reason}}', {
            reason: data.reason || 'unknown'
          })
        );
      }
    },
    onError: () => {
      toast.error(t('settings.updateNotifications.checkError', 'Failed to check for updates'));
    }
  });

  const discard = () => {
    if (!settings) return;
    setLocalEnabled(settings.enabled);
    setLocalRecipients(settings.recipients || '');
  };
  const onFormStateRef = React.useRef(onFormState);
  onFormStateRef.current = onFormState;
  React.useEffect(() => {
    onFormStateRef.current?.({
      isDirty,
      isSaving: updateMutation.isPending,
      save: () => updateMutation.mutate({ enabled: localEnabled, recipients: localRecipients }),
      discard,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, updateMutation.isPending, localEnabled, localRecipients, settings]);


  const handleToggleEnabled = (value: boolean) => {
    setLocalEnabled(value);
  };

  const handleRecipientsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalRecipients(e.target.value);
  };

  if (isLoading) {
    return (
      <Card padding="md">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-neutral-200 dark:bg-neutral-700 rounded w-1/3"></div>
          <div className="h-10 bg-neutral-200 dark:bg-neutral-700 rounded"></div>
          <div className="h-10 bg-neutral-200 dark:bg-neutral-700 rounded"></div>
        </div>
      </Card>
    );
  }

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
        <Bell className="w-5 h-5" />
        {t('settings.updateNotifications.title', 'Update Notifications')}
      </h2>

      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t('settings.updateNotifications.description', 'Receive email notifications when new versions of PicPeak are available.')}
      </p>

      <div className="space-y-4">
        {/* Enable/Disable Toggle */}
        <label className="flex items-center gap-3 p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg cursor-pointer">
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => handleToggleEnabled(e.target.checked)}
            className="w-4 h-4 text-primary-600 bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
          />
          <div>
            <p className="font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.updateNotifications.enableEmails', 'Enable email notifications')}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t('settings.updateNotifications.enableEmailsDesc', 'Send email to admins when a new version is available')}
            </p>
          </div>
        </label>

        {/* Recipients */}
        <div>
          <Input
            type="text"
            value={localRecipients}
            onChange={handleRecipientsChange}
            label={t('settings.updateNotifications.recipients', 'Email Recipients')}
            placeholder={t('settings.updateNotifications.recipientsPlaceholder', 'admin@example.com, other@example.com')}
            helperText={t('settings.updateNotifications.recipientsHelper', 'Comma-separated email addresses. Leave empty to send to all admin users.')}
            leftIcon={<Mail className="w-4 h-4 text-neutral-400" />}
            disabled={!localEnabled}
          />
        </div>

        {/* Last notified version */}
        {settings?.lastNotifiedVersion && (
          <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('settings.updateNotifications.lastNotified', 'Last notification sent for version: {{version}}', {
                version: settings.lastNotifiedVersion
              })}
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => checkMutation.mutate()}
              isLoading={checkMutation.isPending}
              leftIcon={<RefreshCw className="w-4 h-4" />}
              disabled={!localEnabled}
            >
              {t('settings.updateNotifications.checkNow', 'Check & Notify')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => sendMutation.mutate()}
              isLoading={sendMutation.isPending}
              leftIcon={<Send className="w-4 h-4" />}
              disabled={!localEnabled}
            >
              {t('settings.updateNotifications.sendTest', 'Send Test Email')}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};
