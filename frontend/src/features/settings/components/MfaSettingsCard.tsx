import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { ShieldCheck, ShieldOff, Copy, Download, Check, KeyRound } from 'lucide-react';

import { Button, Card, Input, Loading, Notice, useConfirm } from '../../../components/common';
import { mfaService } from '../../../services/mfa.service';

// Per-user admin TOTP MFA management (issue #738). Lives on the admin's own
// account surface (Settings → General → Admin Account). Self-service: acts on
// the currently authenticated admin only.

interface RecoveryCodesPanelProps {
  codes: string[];
  onConfirm: () => void;
}

const RecoveryCodesPanel: React.FC<RecoveryCodesPanelProps> = ({ codes, onConfirm }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const asText = codes.join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(asText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('settings.mfa.copyFailed'));
    }
  };

  const handleDownload = () => {
    const blob = new Blob([`${asText}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'picpeak-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Notice tone="warning">{t('settings.mfa.recoveryCodesWarning')}</Notice>

      <div className="grid grid-cols-2 gap-2 p-4 rounded-lg bg-subtle border border-line font-mono text-sm text-heading">
        {codes.map((code) => (
          <span key={code} className="select-all">{code}</span>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" leftIcon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} onClick={handleCopy}>
          {copied ? t('settings.mfa.copied') : t('settings.mfa.copy')}
        </Button>
        <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={handleDownload}>
          {t('settings.mfa.download')}
        </Button>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-1 w-4 h-4 text-accent rounded focus:ring-accent"
        />
        <span className="text-sm text-body">{t('settings.mfa.recoveryCodesAck')}</span>
      </label>

      <Button variant="primary" disabled={!acknowledged} onClick={onConfirm}>
        {t('settings.mfa.done')}
      </Button>
    </div>
  );
};

export const MfaSettingsCard: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const { data: status, isLoading } = useQuery({
    queryKey: ['admin-mfa-status'],
    queryFn: () => mfaService.getStatus(),
  });

  // Enrollment flow state
  const [setupData, setSetupData] = useState<Awaited<ReturnType<typeof mfaService.setup>> | null>(null);
  const [enableCode, setEnableCode] = useState('');
  const [enableError, setEnableError] = useState<string | null>(null);

  // Recovery codes to display once (after enable or regenerate)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Regenerate flow state
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [regenerateCode, setRegenerateCode] = useState('');
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['admin-mfa-status'] });

  const errorMessage = (error: any, fallbackKey: string): string =>
    error?.response?.data?.error || t(fallbackKey);

  const setupMutation = useMutation({
    mutationFn: () => mfaService.setup(),
    onSuccess: (data) => {
      setSetupData(data);
      setEnableCode('');
      setEnableError(null);
    },
    onError: (error) => toast.error(errorMessage(error, 'settings.mfa.setupFailed')),
  });

  const enableMutation = useMutation({
    mutationFn: (code: string) => mfaService.enable(code),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setSetupData(null);
      setEnableCode('');
      setEnableError(null);
      invalidateStatus();
    },
    onError: (error) => setEnableError(errorMessage(error, 'settings.mfa.enableFailed')),
  });

  const disableMutation = useMutation({
    mutationFn: (code: string) => mfaService.disable(code),
    onSuccess: () => {
      toast.success(t('settings.mfa.disabledToast'));
      invalidateStatus();
    },
    onError: (error) => toast.error(errorMessage(error, 'settings.mfa.disableFailed')),
  });

  const regenerateMutation = useMutation({
    mutationFn: (code: string) => mfaService.regenerateRecoveryCodes(code),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setShowRegenerate(false);
      setRegenerateCode('');
      setRegenerateError(null);
      invalidateStatus();
    },
    onError: (error) => setRegenerateError(errorMessage(error, 'settings.mfa.regenerateFailed')),
  });

  const handleDisable = async () => {
    const code = window.prompt(t('settings.mfa.disablePrompt'));
    if (code === null) return;
    const trimmed = code.trim();
    if (!trimmed) {
      toast.error(t('settings.mfa.codeRequired'));
      return;
    }
    const ok = await confirm({
      title: t('settings.mfa.disableConfirmTitle'),
      message: t('settings.mfa.disableConfirmMessage'),
      variant: 'danger',
      confirmLabel: t('settings.mfa.disableConfirmButton'),
    });
    if (ok) disableMutation.mutate(trimmed);
  };

  return (
    <Card padding="md">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-5 h-5 text-body" />
        <h2 className="text-lg font-semibold text-heading">{t('settings.mfa.title')}</h2>
      </div>
      <p className="text-sm text-soft mb-4">{t('settings.mfa.description')}</p>

      {isLoading ? (
        <div className="py-8 flex justify-center">
          <Loading size="md" />
        </div>
      ) : recoveryCodes ? (
        <RecoveryCodesPanel codes={recoveryCodes} onConfirm={() => setRecoveryCodes(null)} />
      ) : status?.enabled ? (
        /* ---------------- Enrolled ---------------- */
        <div className="space-y-4">
          <Notice tone="success" icon={<ShieldCheck className="w-5 h-5" />}>
            {t('settings.mfa.enabledBadge')}
          </Notice>

          <p className="text-sm text-soft">
            {t('settings.mfa.recoveryCodesRemaining', { count: status.recoveryCodesRemaining })}
          </p>

          {showRegenerate ? (
            <div className="space-y-3 p-4 rounded-lg border border-line">
              <p className="text-sm text-body">{t('settings.mfa.regenerateHelp')}</p>
              <Input
                type="text"
                value={regenerateCode}
                onChange={(e) => {
                  setRegenerateCode(e.target.value);
                  if (regenerateError) setRegenerateError(null);
                }}
                placeholder={t('settings.mfa.codePlaceholder')}
                leftIcon={<KeyRound className="w-5 h-5 text-faint" />}
                error={regenerateError || undefined}
                autoComplete="one-time-code"
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  isLoading={regenerateMutation.isPending}
                  onClick={() => {
                    const trimmed = regenerateCode.trim();
                    if (!trimmed) { setRegenerateError(t('settings.mfa.codeRequired')); return; }
                    regenerateMutation.mutate(trimmed);
                  }}
                >
                  {t('settings.mfa.regenerateConfirm')}
                </Button>
                <Button variant="ghost" onClick={() => { setShowRegenerate(false); setRegenerateCode(''); setRegenerateError(null); }}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setShowRegenerate(true)}>
                {t('settings.mfa.regenerate')}
              </Button>
              <Button
                variant="outline"
                leftIcon={<ShieldOff className="w-4 h-4" />}
                isLoading={disableMutation.isPending}
                onClick={handleDisable}
              >
                {t('settings.mfa.disable')}
              </Button>
            </div>
          )}
        </div>
      ) : setupData ? (
        /* ---------------- Setup in progress ---------------- */
        <div className="space-y-4">
          <p className="text-sm text-body">{t('settings.mfa.setupScanInstruction')}</p>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <img
              src={setupData.qr}
              alt={t('settings.mfa.qrAlt')}
              className="w-44 h-44 rounded-lg border border-line bg-panel p-2"
            />
            <div className="space-y-2">
              <p className="text-sm text-soft">{t('settings.mfa.manualEntry')}</p>
              <code className="block px-3 py-2 rounded bg-subtle text-sm font-mono text-heading break-all select-all">
                {setupData.secret}
              </code>
            </div>
          </div>

          <div>
            <label htmlFor="mfa-enable-code" className="block text-sm font-medium text-body mb-1">
              {t('settings.mfa.enterCodeLabel')}
            </label>
            <Input
              id="mfa-enable-code"
              type="text"
              value={enableCode}
              onChange={(e) => {
                setEnableCode(e.target.value);
                if (enableError) setEnableError(null);
              }}
              placeholder={t('settings.mfa.codePlaceholder')}
              leftIcon={<KeyRound className="w-5 h-5 text-faint" />}
              error={enableError || undefined}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </div>

          <div className="flex gap-2">
            <Button
              variant="primary"
              isLoading={enableMutation.isPending}
              onClick={() => {
                const trimmed = enableCode.trim();
                if (!trimmed) { setEnableError(t('settings.mfa.codeRequired')); return; }
                enableMutation.mutate(trimmed);
              }}
            >
              {t('settings.mfa.enable')}
            </Button>
            <Button variant="ghost" onClick={() => { setSetupData(null); setEnableCode(''); setEnableError(null); }}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        /* ---------------- Not enrolled ---------------- */
        <div className="space-y-3">
          <p className="text-sm text-soft">{t('settings.mfa.notEnrolled')}</p>
          <Button
            variant="primary"
            leftIcon={<ShieldCheck className="w-5 h-5" />}
            isLoading={setupMutation.isPending}
            onClick={() => setupMutation.mutate()}
          >
            {t('settings.mfa.setUp')}
          </Button>
        </div>
      )}
    </Card>
  );
};
