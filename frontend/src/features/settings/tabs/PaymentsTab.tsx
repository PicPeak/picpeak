import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AxiosError } from 'axios';
import { toast } from 'react-toastify';
import { Button, Card, Input, Loading, Notice } from '../../../components/common';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import { paymentsService, type PaymentSettingsUpdate } from '../../../services/payments.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

export const PaymentsTab: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const isDirty = secretKey !== '' || webhookSecret !== '';
  const query = useQuery({ queryKey: ['admin-payments'], queryFn: paymentsService.get });
  const discard = () => { setSecretKey(''); setWebhookSecret(''); setDraftRevision(null); };
  const message = (error: AxiosError<{ error?: string }>) => toast.error(error.response?.data?.error || t('settings.payments.failed'));
  const save = useMutation({
    mutationFn: (input: PaymentSettingsUpdate) => paymentsService.save(input),
    onSuccess: (data) => {
      discard();
      test.reset();
      queryClient.setQueryData(['admin-payments'], data);
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-event-photo-orders'] });
      toast.success(t('settings.payments.saved'));
    },
    onError: message,
  });
  const test = useMutation({ mutationFn: paymentsService.test, onError: message });
  const data = query.data;
  if (query.isLoading) return <Loading />;
  if (!data) return <Notice tone="warning" title={t('settings.payments.loadFailed')}>
    <Button variant="outline" onClick={() => void query.refetch()}>{t('common.retry', 'Retry')}</Button>
  </Notice>;

  const pinned = data.source === 'environment';
  const ready = data.checkout_configured && data.webhook_configured;
  return <div className="space-y-6">
    <Card><div className="p-6 space-y-5">
      <p className="text-sm text-soft">{t('settings.payments.intro')}</p>
      <Notice tone={ready ? 'info' : 'warning'} title={!ready ? t('settings.payments.notConfigured') : data.test_mode ? t('settings.payments.testMode') : t('settings.payments.liveMode')}>
        {!ready ? t('settings.payments.notConfiguredHelp') : data.test_mode ? t('settings.payments.testHelp') : t('settings.payments.liveHelp')}
      </Notice>
      {pinned && <Notice tone="info" title={t('settings.payments.serverManaged')}>{t('settings.payments.serverManagedHelp')}</Notice>}
      {data.unreadable && <Notice tone="warning" title={t('settings.payments.unreadable')}>{t('settings.payments.unreadableHelp')}</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        <Input id="stripe-api-key" type="password" autoComplete="new-password" spellCheck={false}
          label={t('settings.payments.apiKey')} value={secretKey} disabled={pinned || save.isPending}
          onChange={(event) => { setDraftRevision((prev) => prev ?? data.revision); setSecretKey(event.target.value); test.reset(); }}
          placeholder={data.checkout_configured ? t('settings.payments.savedSecret') : 'rk_test_…'}
          helperText={t('settings.payments.blankKeeps')} />
        <Input id="stripe-webhook-secret" type="password" autoComplete="new-password" spellCheck={false}
          label={t('settings.payments.webhookSecret')} value={webhookSecret} disabled={pinned || save.isPending}
          onChange={(event) => { setDraftRevision((prev) => prev ?? data.revision); setWebhookSecret(event.target.value); test.reset(); }}
          placeholder={data.webhook_configured ? t('settings.payments.savedSecret') : 'whsec_…'}
          helperText={t('settings.payments.blankKeeps')} />
      </div>
      {(test.data?.account_id || data.account_id) && <p className="text-sm text-soft">{t('settings.payments.account', { account: test.data?.account_id || data.account_id })}</p>}
      <Button variant="outline" disabled={!data.checkout_configured || isDirty || save.isPending || test.isPending} isLoading={test.isPending} onClick={() => test.mutate()}>
        {t('settings.payments.checkApi')}
      </Button>
      {!isDirty && (test.data || data.api_verified_at) && <p role="status" className="text-sm text-soft">{t('settings.payments.apiChecked')}</p>}
      <p className="text-sm text-soft">{t('settings.payments.checkLimit')}</p>
    </div></Card>
    <Card><div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold text-body">{t('settings.payments.setup')}</h2>
      <ol className="list-decimal pl-5 space-y-3 text-sm text-soft">
        <li>{t('settings.payments.stepKey')} <a href="https://docs.stripe.com/keys/restricted-api-keys" target="_blank" rel="noopener noreferrer" className="text-accent underline">{t('settings.payments.keyGuide')}</a></li>
        <li>{t('settings.payments.stepWebhook')}
          <Input id="stripe-webhook-url" label={t('settings.payments.webhookUrl')} readOnly value={data.webhook_url} onFocus={(event) => event.target.select()} />
          <p className="mt-2">{t('settings.payments.version', { version: data.api_version })}</p>
          <details className="mt-2"><summary className="cursor-pointer">{t('settings.payments.events')}</summary>
            <ul className="mt-2 space-y-1">{data.webhook_events.map((event) => <li key={event}><code className="break-all">{event}</code></li>)}</ul>
          </details>
        </li>
        <li>{t('settings.payments.stepSave')}</li>
        <li>{t('settings.payments.stepVerify')}</li>
      </ol>
      <Notice tone={data.webhook_verified_at ? 'info' : 'warning'} title={data.webhook_verified_at ? t('settings.payments.webhookSeen') : t('settings.payments.webhookUnseen')}>
        {data.webhook_verified_at ? t('settings.payments.webhookSeenHelp', { time: formatDateTime(data.webhook_verified_at) }) : t('settings.payments.webhookUnseenHelp')}
      </Notice>
    </div></Card>
    {!pinned && <SettingsSaveBar isDirty={isDirty} isSaving={save.isPending} onDiscard={discard}
      onSave={() => save.mutate({ revision: draftRevision || data.revision, ...(secretKey.trim() ? { secret_key: secretKey.trim() } : {}), ...(webhookSecret.trim() ? { webhook_secret: webhookSecret.trim() } : {}) })} />}
  </div>;
};
