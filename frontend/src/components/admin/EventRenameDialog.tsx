import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Type, Mail } from 'lucide-react';
import { Button, Input, Modal, Notice } from '../common';

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
  const nameInputRef = useRef<HTMLInputElement>(null);
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

  const renameDisabled =
    !validationResult?.valid ||
    isValidating ||
    newName.trim() === eventName.trim() ||
    newName.trim().length < 3;

  const footer = renameResult?.success ? (
    <Button variant="primary" onClick={onClose}>
      {t('common.done', 'Done')}
    </Button>
  ) : renameResult?.error ? (
    <>
      <Button variant="outline" onClick={() => setRenameResult(null)}>
        {t('common.retry', 'Retry')}
      </Button>
      <Button variant="primary" onClick={onClose}>
        {t('common.close', 'Close')}
      </Button>
    </>
  ) : isRenaming ? undefined : (
    <>
      <Button variant="outline" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button
        variant="primary"
        onClick={handleRename}
        disabled={renameDisabled}
      >
        {t('events.rename.confirm', 'Rename Event')}
      </Button>
    </>
  );

  return (
    <Modal
      open={isOpen}
      onClose={() => { if (!isRenaming) onClose(); }}
      closeOnBackdrop={false}
      size="md"
      initialFocusRef={nameInputRef}
      title={t('events.rename.title', 'Rename Event')}
      footer={footer}
    >
        {renameResult?.success ? (
          // Success state
          <div className="space-y-4">
            <Notice tone="success" title={t('events.rename.success', 'Event renamed successfully!')}>
              {renameResult.filesRenamed !== undefined && renameResult.filesRenamed > 0
                ? t('events.rename.filesRenamed', '{{count}} files updated', { count: renameResult.filesRenamed })
                : null}
            </Notice>

            {renameResult.newShareLink && (
              <div className="p-3 bg-subtle rounded-lg">
                <p className="text-sm font-medium text-body mb-1">
                  {t('events.rename.newLink', 'New Gallery Link')}
                </p>
                <p className="text-sm text-heading break-all">{renameResult.newShareLink}</p>
              </div>
            )}
          </div>
        ) : renameResult?.error ? (
          // Error state
          <Notice tone="danger" title={t('events.rename.failed', 'Rename failed')}>
            {renameResult.error}
          </Notice>
        ) : isRenaming ? (
          // Renaming in progress
          <div className="space-y-4 py-8">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-10 h-10 text-accent animate-spin" />
              <p className="text-body font-medium">{renameStatus}</p>
            </div>
          </div>
        ) : (
          // Input form
          <div className="space-y-4">
            <div>
              <p className="text-sm text-soft mb-3">
                {t('events.rename.currentName', 'Current name:')} <span className="font-medium">{eventName}</span>
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-body mb-1">
                {t('events.rename.newName', 'New Event Name')}
              </label>
              <Input
                ref={nameInputRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('events.rename.enterNewName', 'Enter new event name')}
                leftIcon={<Type className="w-5 h-5 text-faint" />}
                autoFocus
              />
            </div>

            {/* New slug preview */}
            {validationResult?.valid && validationResult.newSlug && (
              <Notice tone="success" size="sm">
                <span className="font-medium">{t('events.rename.newUrl', 'New URL:')}</span>{' '}
                <span className="break-all">/gallery/{validationResult.newSlug}/...</span>
              </Notice>
            )}

            {/* Validation status */}
            {isValidating && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('events.rename.checkingAvailability', 'Checking availability...')}
              </div>
            )}

            {validationResult && !validationResult.valid && (
              <Notice tone="danger" size="sm">
                {validationResult.error}
              </Notice>
            )}

            {/* Resend email option */}
            {customerEmail && (
              <div className="pt-2 border-t border-line">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={resendEmail}
                    onChange={(e) => setResendEmail(e.target.checked)}
                    className="mt-1 w-4 h-4 text-accent border-line-strong rounded focus:ring-accent"
                  />
                  <div>
                    <span className="text-sm font-medium text-body flex items-center gap-1">
                      <Mail className="w-4 h-4" />
                      {t('events.rename.resendEmail', 'Resend invitation email with new gallery link')}
                    </span>
                    <p className="text-xs text-muted mt-1">
                      {t('events.rename.emailTo', 'Send updated gallery access email to')} {customerEmail}
                    </p>
                  </div>
                </label>
              </div>
            )}

            {/* Warning */}
            <Notice tone="warning" size="sm" title={t('events.rename.warningTitle', 'Please note:')}>
              <ul className="list-disc list-inside space-y-1">
                <li>{t('events.rename.warning1', 'The gallery URL will change')}</li>
                <li>{t('events.rename.warning2', 'Old URLs will automatically redirect to the new URL')}</li>
                <li>{t('events.rename.warning3', 'Photo files may be renamed')}</li>
              </ul>
            </Notice>
          </div>
        )}
    </Modal>
  );
};

EventRenameDialog.displayName = 'EventRenameDialog';
