import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, AlertCircle, CheckCircle, Loader2, Type, Mail } from 'lucide-react';
import { Button, Input, Card } from '../common';

interface EventRenameDialogProps {
  isOpen: boolean;
  eventName: string;
  eventId: number;
  customerEmail?: string;
  onClose: () => void;
  onRename: (newName: string, resendEmail: boolean) => Promise<{
    success: boolean;
    data?: {
      newSlug: string;
      newShareLink: string;
      filesRenamed: number;
    };
    error?: string;
  }>;
  onValidate: (newName: string) => Promise<{
    valid: boolean;
    newSlug?: string;
    error?: string;
  }>;
}

export const EventRenameDialog: React.FC<EventRenameDialogProps> = ({
  isOpen,
  eventName,
  eventId: _eventId,
  customerEmail,
  onClose,
  onRename,
  onValidate
}) => {
  const { t } = useTranslation();
  const [newName, setNewName] = useState(eventName);
  const [resendEmail, setResendEmail] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    newSlug?: string;
    error?: string;
  } | null>(null);
  const [renameStatus, setRenameStatus] = useState<string | null>(null);
  const [renameResult, setRenameResult] = useState<{
    success: boolean;
    newSlug?: string;
    newShareLink?: string;
    filesRenamed?: number;
    error?: string;
  } | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setNewName(eventName);
      setResendEmail(false);
      setValidationResult(null);
      setRenameStatus(null);
      setRenameResult(null);
    }
  }, [isOpen, eventName]);

  // Debounced validation
  useEffect(() => {
    if (!isOpen || newName.trim() === eventName.trim() || newName.trim().length < 3) {
      setValidationResult(null);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setIsValidating(true);
      try {
        const result = await onValidate(newName.trim());
        setValidationResult(result);
      } catch (error) {
        setValidationResult({ valid: false, error: 'Validation failed' });
      } finally {
        setIsValidating(false);
      }
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [newName, eventName, isOpen, onValidate]);

  const handleRename = async () => {
    if (!validationResult?.valid) return;

    setIsRenaming(true);
    setRenameStatus(t('events.rename.validating', 'Validating new name...'));

    try {
      setRenameStatus(t('events.rename.renamingFiles', 'Renaming files...'));

      const result = await onRename(newName.trim(), resendEmail);

      if (result.success) {
        setRenameStatus(t('events.rename.complete', 'Complete!'));
        setRenameResult({
          success: true,
          newSlug: result.data?.newSlug,
          newShareLink: result.data?.newShareLink,
          filesRenamed: result.data?.filesRenamed
        });
      } else {
        setRenameResult({
          success: false,
          error: result.error || 'Rename failed'
        });
      }
    } catch (error: any) {
      setRenameResult({
        success: false,
        error: error.message || 'Rename failed'
      });
    } finally {
      setIsRenaming(false);
      setRenameStatus(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="max-w-lg w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-neutral-900">
            {t('events.rename.title', 'Rename Event')}
          </h2>
          <button
            onClick={onClose}
            disabled={isRenaming}
            className="text-neutral-400 hover:text-neutral-600 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {renameResult?.success ? (
          // Success state
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg">
              <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0" />
              <div>
                <p className="font-medium text-green-900">
                  {t('events.rename.success', 'Event renamed successfully!')}
                </p>
                {renameResult.filesRenamed !== undefined && renameResult.filesRenamed > 0 && (
                  <p className="text-sm text-green-700 mt-1">
                    {t('events.rename.filesRenamed', '{{count}} files updated', { count: renameResult.filesRenamed })}
                  </p>
                )}
              </div>
            </div>

            {renameResult.newShareLink && (
              <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200 mb-1">
                  {t('events.rename.newLink', 'New Gallery Link')}
                </p>
                <p className="text-sm text-neutral-900 dark:text-neutral-100 break-all">{renameResult.newShareLink}</p>
              </div>
            )}

            <div className="flex justify-end">
              <Button variant="primary" onClick={onClose}>
                {t('common.done', 'Done')}
              </Button>
            </div>
          </div>
        ) : renameResult?.error ? (
          // Error state
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-red-50 rounded-lg">
              <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0" />
              <div>
                <p className="font-medium text-red-900">
                  {t('events.rename.failed', 'Rename failed')}
                </p>
                <p className="text-sm text-red-700 mt-1">{renameResult.error}</p>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRenameResult(null)}>
                {t('common.retry', 'Retry')}
              </Button>
              <Button variant="primary" onClick={onClose}>
                {t('common.close', 'Close')}
              </Button>
            </div>
          </div>
        ) : isRenaming ? (
          // Renaming in progress
          <div className="space-y-4 py-8">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-10 h-10 text-accent animate-spin" />
              <p className="text-neutral-700 font-medium">{renameStatus}</p>
            </div>
          </div>
        ) : (
          // Input form
          <div className="space-y-4">
            <div>
              <p className="text-sm text-neutral-600 mb-3">
                {t('events.rename.currentName', 'Current name:')} <span className="font-medium">{eventName}</span>
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">
                {t('events.rename.newName', 'New Event Name')}
              </label>
              <Input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('events.rename.enterNewName', 'Enter new event name')}
                leftIcon={<Type className="w-5 h-5 text-neutral-400" />}
                autoFocus
              />
            </div>

            {/* New slug preview */}
            {validationResult?.valid && validationResult.newSlug && (
              <div className="p-3 bg-green-50 rounded-lg">
                <p className="text-sm text-green-800">
                  <span className="font-medium">{t('events.rename.newUrl', 'New URL:')}</span>{' '}
                  <span className="break-all">/gallery/{validationResult.newSlug}/...</span>
                </p>
              </div>
            )}

            {/* Validation status */}
            {isValidating && (
              <div className="flex items-center gap-2 text-sm text-neutral-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('events.rename.checkingAvailability', 'Checking availability...')}
              </div>
            )}

            {validationResult && !validationResult.valid && (
              <div className="flex items-center gap-2 p-3 bg-red-50 rounded-lg">
                <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                <p className="text-sm text-red-700">{validationResult.error}</p>
              </div>
            )}

            {/* Resend email option */}
            {customerEmail && (
              <div className="pt-2 border-t border-neutral-200">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={resendEmail}
                    onChange={(e) => setResendEmail(e.target.checked)}
                    className="mt-1 w-4 h-4 text-accent border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-neutral-700 flex items-center gap-1">
                      <Mail className="w-4 h-4" />
                      {t('events.rename.resendEmail', 'Resend invitation email with new gallery link')}
                    </span>
                    <p className="text-xs text-neutral-500 mt-1">
                      {t('events.rename.emailTo', 'Send updated gallery access email to')} {customerEmail}
                    </p>
                  </div>
                </label>
              </div>
            )}

            {/* Warning */}
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
              <div className="flex gap-2">
                <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium">{t('events.rename.warningTitle', 'Please note:')}</p>
                  <ul className="mt-1 list-disc list-inside space-y-1">
                    <li>{t('events.rename.warning1', 'The gallery URL will change')}</li>
                    <li>{t('events.rename.warning2', 'Old URLs will automatically redirect to the new URL')}</li>
                    <li>{t('events.rename.warning3', 'Photo files may be renamed')}</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleRename}
                disabled={
                  !validationResult?.valid ||
                  isValidating ||
                  newName.trim() === eventName.trim() ||
                  newName.trim().length < 3
                }
              >
                {t('events.rename.confirm', 'Rename Event')}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

EventRenameDialog.displayName = 'EventRenameDialog';
