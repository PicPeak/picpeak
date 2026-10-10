import React, { useState } from 'react';
import { Key, Copy, CheckCircle, Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal, Notice, PasswordGenerator } from '../common';

interface PasswordResetModalProps {
  eventName: string;
  eventDate?: string;
  eventType?: string;
  onConfirm: (sendEmail: boolean, password?: string) => Promise<{ newPassword: string; emailSent: boolean }>;
  onClose: () => void;
}

export const PasswordResetModal: React.FC<PasswordResetModalProps> = ({
  eventName,
  eventDate,
  eventType,
  onConfirm,
  onClose
}) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
  const [isResetting, setIsResetting] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; confirmPassword?: string }>({});
  const [resultPassword, setResultPassword] = useState<string | null>(null);
  const [resultWasGenerated, setResultWasGenerated] = useState(false);
  // What the server did, not what was asked: the event may have no address,
  // or the queue write may have failed after the password changed.
  const [resultEmailSent, setResultEmailSent] = useState(false);
  const [copied, setCopied] = useState(false);

  const validate = (): boolean => {
    const next: typeof errors = {};
    // Empty is allowed → server auto-generates. Only validate when typed.
    if (password) {
      if (password.length < 6) {
        next.password = t('events.passwordReset.errorMinLength');
      }
      if (password !== confirmPassword) {
        next.confirmPassword = t('events.passwordReset.errorMismatch');
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleReset = async () => {
    if (!validate()) return;
    setIsResetting(true);
    try {
      const supplied = password.length > 0 ? password : undefined;
      const result = await onConfirm(sendEmail, supplied);
      setResultPassword(result.newPassword);
      setResultWasGenerated(!supplied);
      setResultEmailSent(result.emailSent === true);
      if (supplied) {
        toast.success(t('events.passwordReset.toastSuccess'));
      }
    } catch (error: any) {
      const serverError = error?.response?.data;
      if (serverError?.error === 'Password does not meet security requirements') {
        setErrors({ password: serverError.feedback?.join?.(' ') || t('events.passwordReset.errorMinLength') });
      } else {
        toast.error(serverError?.error || t('events.passwordReset.toastError'));
      }
    } finally {
      setIsResetting(false);
    }
  };

  const handleCopy = async () => {
    if (resultPassword) {
      await navigator.clipboard.writeText(resultPassword);
      setCopied(true);
      toast.success(t('events.passwordReset.toastCopied'));
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePasswordGenerated = (generated: string) => {
    setPassword(generated);
    setConfirmPassword(generated);
    setErrors({});
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={false}
      size="sm"
      title={resultPassword ? t('events.passwordReset.newTitle') : t('events.passwordReset.title')}
      footer={!resultPassword ? (
        <>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isResetting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleReset}
            disabled={isResetting}
            isLoading={isResetting}
            leftIcon={<Key className="w-4 h-4" />}
          >
            {t('events.passwordReset.submit')}
          </Button>
        </>
      ) : (
        <Button
          variant="primary"
          onClick={onClose}
        >
          {t('events.passwordReset.done')}
        </Button>
      )}
    >
        {!resultPassword ? (
          <>
            <p className="text-soft mb-4">
              {t('events.passwordReset.description', { eventName })}
            </p>

            <div className="space-y-4 mb-4">
              <div>
                <Input
                  type={showPassword ? 'text' : 'password'}
                  label={t('events.passwordReset.newPasswordLabel')}
                  placeholder={t('events.passwordReset.placeholder')}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
                  }}
                  error={errors.password}
                  helperText={t('events.passwordReset.helperText')}
                  leftIcon={<Lock className="w-5 h-5" />}
                  rightIcon={
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="p-1"
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  }
                />

                <div className="mt-2">
                  <PasswordGenerator
                    eventName={eventName}
                    eventDate={eventDate}
                    eventType={eventType}
                    onPasswordGenerated={handlePasswordGenerated}
                    passwordComplexity="moderate"
                    className="w-full"
                  />
                </div>
              </div>

              {password.length > 0 && (
                <Input
                  type={showPassword ? 'text' : 'password'}
                  label={t('events.passwordReset.confirmLabel')}
                  placeholder={t('events.passwordReset.confirmLabel')}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (errors.confirmPassword) setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                  }}
                  error={errors.confirmPassword}
                  leftIcon={<Lock className="w-5 h-5" />}
                />
              )}
            </div>

            <div className="mb-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  className="w-4 h-4 text-accent bg-inset border-line-strong rounded focus:ring-accent focus:ring-2"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-muted" />
                    <span className="text-sm font-medium text-body">
                      {t('events.passwordReset.sendEmail')}
                    </span>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    {t('events.passwordReset.sendEmailHelp')}
                  </p>
                </div>
              </label>
            </div>

            <Notice tone="warning" size="sm">
              {t('events.passwordReset.warning')}
            </Notice>
          </>
        ) : (
          <>
            <Notice tone="success" title={t('events.passwordReset.successHeading')} className="mb-4">
              {sendEmail && resultEmailSent ? t('events.passwordReset.emailSentNote') : null}
            </Notice>
            {sendEmail && !resultEmailSent && (
              <Notice tone="warning" size="sm" className="mb-4">
                {t('events.passwordReset.emailNotSentNote')}
              </Notice>
            )}

            {resultWasGenerated && (
              <>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-body mb-2">
                    {t('events.passwordReset.generatedLabel')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={resultPassword}
                      readOnly
                      className="flex-1 px-3 py-2 bg-subtle border border-line-strong text-heading rounded-lg font-mono text-sm"
                    />
                    <Button
                      variant="outline"
                      onClick={handleCopy}
                      leftIcon={copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    >
                      {copied ? t('events.copied') : t('events.copy')}
                    </Button>
                  </div>
                </div>

                <Notice tone="info" size="sm">
                  {t('events.passwordReset.saveSecurelyNote')}
                </Notice>
              </>
            )}
          </>
        )}
    </Modal>
  );
};
