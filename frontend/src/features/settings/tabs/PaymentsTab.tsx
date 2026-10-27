import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AxiosError } from 'axios';
import { toast } from 'react-toastify';
import { Check, Copy, ExternalLink } from 'lucide-react';
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
  const [step, setStep] = useState(0);
  const [checkedRevision, setCheckedRevision] = useState<string | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { stepHeading.current?.focus(); }, [step]);
  const isDirty = secretKey !== '' || webhookSecret !== '';
  const query = useQuery({ queryKey: ['admin-payments'], queryFn: paymentsService.get });
  const discard = () => { setSecretKey(''); setWebhookSecret(''); setDraftRevision(null); setCheckedRevision(null); };
  const message = (error: AxiosError<{ error?: string }>) => toast.error(error.response?.data?.error || t('settings.payments.failed'));
  const save = useMutation({
    mutationFn: (input: PaymentSettingsUpdate) => paymentsService.save(input),
    onSuccess: (data) => {
      discard();
      test.reset();
      queryClient.setQueryData(['admin-payments'], data);
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-event-photo-orders'] });
      setStep(4);
      toast.success(t('settings.payments.saved'));
    },
    onError: message,
  });
  const test = useMutation({
    mutationFn: paymentsService.test,
    onMutate: () => setCheckedRevision(query.data?.revision || null),
    onError: message,
  });
  const data = query.data;
  if (query.isLoading) return <Loading />;
  if (!data) return <Notice tone="warning" title={t('settings.payments.loadFailed', 'Payment settings could not be loaded')}>
    <Button variant="outline" onClick={() => void query.refetch()}>{t('common.retry', 'Retry')}</Button>
  </Notice>;

  const pinned = data.source === 'environment';
  const ready = data.checkout_configured && data.webhook_configured;
  const currentCheck = !isDirty && checkedRevision === data.revision ? test.data : undefined;
  const apiChecked = !isDirty && !!(currentCheck || data.api_verified_at);
  const canSave = !!((secretKey.trim() || data.checkout_configured) && (webhookSecret.trim() || data.webhook_configured));
  const steps = [
    t('settings.payments.wizard.address', 'Check your gallery address'),
    t('settings.payments.wizard.key', 'Add a restricted Stripe key'),
    t('settings.payments.wizard.notifications', 'Set up payment notifications'),
    t('settings.payments.wizard.review', 'Save and check access'),
    t('settings.payments.wizard.purchase', 'Test a purchase'),
  ];
  const completed = [data.site_url_ready && !!data.webhook_url, data.checkout_configured, data.webhook_configured, apiChecked, false];
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('settings.payments.wizard.copied', 'Copied to clipboard'));
    } catch {
      toast.error(t('settings.payments.wizard.copyFailed', 'Could not copy. Select the text and copy it manually.'));
    }
  };
  const stripeLink = (href: string, label: string) => <a href={href} target="_blank" rel="noopener noreferrer"
    className="inline-flex items-center gap-1 text-accent underline underline-offset-2">
    {label}<ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
  </a>;
  return <div className="space-y-6">
    <Card><div className="p-6 space-y-5">
      {step === 0 && <p className="text-sm text-soft">{t('settings.payments.intro', 'One Stripe merchant account receives photo payments from every gallery on this installation. Only super admins can change credentials. Set individual prices in each gallery’s Photo sales settings.')}</p>}
      <Notice tone={ready ? 'info' : 'warning'} title={!ready ? t('settings.payments.notConfigured', 'Stripe is not configured') : data.test_mode ? t('settings.payments.testMode', 'Stripe test mode') : t('settings.payments.liveMode', 'Stripe live mode')}>
        {step === 0 && (!ready ? t('settings.payments.notConfiguredHelp', 'Complete the setup below before accepting photo purchases.') : data.test_mode ? t('settings.payments.testHelp', 'Test checkouts do not collect real money. Complete a test purchase and refund before going live.') : t('settings.payments.liveHelp', 'New checkouts collect real payments into the configured Stripe account.'))}
      </Notice>
      {pinned && <Notice tone="info" title={t('settings.payments.serverManaged', 'Managed by the server')}>{t('settings.payments.serverManagedHelp', 'STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is set in the server environment. These values take precedence as a pair. Ask the server operator to remove both variables before managing credentials here.')}</Notice>}
      {data.unreadable && <Notice tone="warning" title={t('settings.payments.unreadable', 'Saved credentials could not be decrypted')}>{t('settings.payments.unreadableHelp', 'Restore the payment encryption key or enter both credentials again for the same Stripe account.')}</Notice>}
      <nav aria-label={t('settings.payments.wizard.steps', 'Stripe setup steps')}>
        <p className="text-sm text-soft sm:hidden" aria-live="polite">{t('settings.payments.wizard.progress', 'Step {{current}} of {{total}}', { current: step + 1, total: steps.length })}</p>
        <ol className="hidden sm:grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {steps.map((label, index) => <li key={index}>
            <button type="button" aria-current={step === index ? 'step' : undefined} disabled={save.isPending}
              onClick={() => setStep(index)} className={`w-full rounded-lg border p-3 text-left text-sm flex items-start gap-2 ${step === index ? 'border-accent bg-accent-soft text-heading' : 'border-line text-soft hover:bg-hover'}`}>
              <span className="shrink-0 tabular-nums">{index + 1}.</span>
              <span className="flex-1">{label}</span>
              {completed[index] && <Check className="w-4 h-4 shrink-0 text-success-text" aria-label={t('settings.payments.wizard.savedStep', 'Configuration saved')} />}
            </button>
          </li>)}
        </ol>
      </nav>
    </div></Card>
    <Card><div className="p-6 space-y-5">
      <h2 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold text-heading outline-none">{steps[step]}</h2>
      {step === 0 && <>
        <p className="text-sm text-soft">{t('settings.payments.wizard.beforeStart', 'You need a Stripe account for your business and a public PicPeak address using HTTPS. Stripe handles business verification and bank details. Start in a Stripe sandbox so you can practise without real payments.')}</p>
        {stripeLink('https://dashboard.stripe.com/', t('settings.payments.wizard.openStripe', 'Open Stripe Dashboard'))}
        <Input id="stripe-site-url" readOnly label={t('settings.payments.wizard.siteUrl', 'Public PicPeak address')}
          value={data.site_url} onFocus={(event) => event.target.select()} />
        <Notice tone={data.site_url_ready && data.webhook_url ? 'info' : 'warning'}
          title={data.site_url_ready && data.webhook_url ? t('settings.payments.wizard.addressSet', 'HTTPS address configured') : t('settings.payments.wizard.addressMissing', 'Set your public HTTPS address first')}>
          {t('settings.payments.wizard.addressHelp', 'Set the Site URL in Settings → General. Stripe must be able to reach PicPeak from the internet; a local or VPN-only address is not enough. This checks the address format, not delivery.')}
        </Notice>
      </>}
      {step === 1 && <>
        <p className="text-sm text-soft">{t('settings.payments.wizard.keyHelp', 'In Stripe, select the account and sandbox you want to use. Open API keys, create a restricted key named PicPeak, and copy it into the field below. Do not use a publishable key.')}</p>
        <div className="flex flex-wrap gap-4">
          {stripeLink('https://dashboard.stripe.com/apikeys', t('settings.payments.wizard.openKeys', 'Open Stripe API keys'))}
          {stripeLink('https://docs.stripe.com/keys/restricted-api-keys', t('settings.payments.keyGuide', 'Restricted-key guide'))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <caption className="text-left text-soft pb-2">{t('settings.payments.wizard.permissions', 'Give this key the following permissions. Leave unrelated permissions disabled.')}</caption>
            <thead><tr className="border-b border-line"><th className="py-2 pr-4">{t('settings.payments.wizard.resource', 'Stripe resource')}</th><th className="py-2">{t('settings.payments.wizard.access', 'Access')}</th></tr></thead>
            <tbody>{['Account', 'Checkout Sessions', 'Payment Intents', 'Charges', 'Refunds'].map((resource) => <tr key={resource} className="border-b border-line-faint">
              <td className="py-2 pr-4">{resource}</td><td className="py-2">{resource === 'Checkout Sessions' || resource === 'Refunds'
                ? t('settings.payments.wizard.write', 'Write (includes read)') : t('settings.payments.wizard.read', 'Read')}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="text-xs text-soft">{t('settings.payments.wizard.pricePermissions', 'Stripe may also require Products/Prices write access for inline photo prices. Confirm the permissions with a sandbox purchase and refund in the final step.')}</p>
        <Input id="stripe-api-key" type="password" autoComplete="new-password" spellCheck={false}
          label={t('settings.payments.apiKey', 'Stripe API key')} value={secretKey} disabled={pinned || save.isPending}
          onChange={(event) => { setDraftRevision((prev) => prev ?? data.revision); setSecretKey(event.target.value); test.reset(); }}
          placeholder={data.checkout_configured ? t('settings.payments.savedSecret', 'Saved — enter a replacement to change') : 'rk_test_…'}
          helperText={t('settings.payments.blankKeeps', 'Leave blank to keep the saved value. Saved secrets are never displayed.')} />
        <p className="text-sm text-soft">{t('settings.payments.wizard.matchMode', 'Use the same Stripe account and environment for the API key and the signing secret. A test key starts with rk_test_; a live key starts with rk_live_. Never paste either value into chat or support messages.')}</p>
      </>}
      {step === 2 && <>
        <p className="text-sm text-soft">{t('settings.payments.wizard.notificationHelp', 'Stripe must notify PicPeak when a payment succeeds, fails or is refunded. This is required to deliver purchases. In Stripe Workbench → Webhooks, add an event destination for your account using this URL.')}</p>
        {stripeLink('https://dashboard.stripe.com/webhooks', t('settings.payments.wizard.openWebhooks', 'Open Stripe webhooks'))}
        <div className="flex flex-col sm:flex-row sm:items-end gap-2">
          <Input id="stripe-webhook-url" label={t('settings.payments.webhookUrl', 'Webhook endpoint URL')} readOnly value={data.webhook_url} onFocus={(event) => event.target.select()} />
          <Button variant="outline" disabled={!data.webhook_url} onClick={() => void copy(data.webhook_url)} leftIcon={<Copy className="w-4 h-4" />} className="shrink-0">
            {t('settings.payments.wizard.copyUrl', 'Copy URL')}
          </Button>
        </div>
        {!data.webhook_url && <Notice tone="warning">{t('settings.payments.wizard.addressHelp', 'Set the Site URL in Settings → General. Stripe must be able to reach PicPeak from the internet; a local or VPN-only address is not enough. This checks the address format, not delivery.')}</Notice>}
        <p className="text-sm text-soft">{t('settings.payments.version', 'Choose API version {{version}} and subscribe to these events.', { version: data.api_version })}</p>
        <ul aria-label={t('settings.payments.events', 'Required webhook events')} className="space-y-1 text-sm text-body">
          {data.webhook_events.map((event) => <li key={event}><code className="break-all">{event}</code></li>)}
        </ul>
        <Button variant="outline" onClick={() => void copy(data.webhook_events.join('\n'))} leftIcon={<Copy className="w-4 h-4" />}>
          {t('settings.payments.wizard.copyEvents', 'Copy event names')}
        </Button>
        <p className="text-sm text-soft">{t('settings.payments.wizard.signingHelp', 'After creating the destination, reveal its signing secret in Stripe and paste it below. It starts with whsec_. Keep it private, just like the API key.')}</p>
        <Input id="stripe-webhook-secret" type="password" autoComplete="new-password" spellCheck={false}
          label={t('settings.payments.webhookSecret', 'Webhook signing secret')} value={webhookSecret} disabled={pinned || save.isPending}
          onChange={(event) => { setDraftRevision((prev) => prev ?? data.revision); setWebhookSecret(event.target.value); test.reset(); }}
          placeholder={data.webhook_configured ? t('settings.payments.savedSecret', 'Saved — enter a replacement to change') : 'whsec_…'}
          helperText={t('settings.payments.blankKeeps', 'Leave blank to keep the saved value. Saved secrets are never displayed.')} />
      </>}
      {step === 3 && <>
        <p className="text-sm text-soft">{t('settings.payments.wizard.saveHelp', 'Review both credentials, then use Save changes below. Saving checks read access to Stripe and stores the credentials encrypted. It does not create a payment. You can return to any step without losing your unsaved entries.')}</p>
        <dl className="grid gap-2 sm:grid-cols-2 text-sm">
          <dt className="text-soft">{t('settings.payments.apiKey', 'Stripe API key')}</dt>
          <dd className="text-body">{secretKey.trim() ? t('settings.payments.wizard.entered', 'New value entered') : data.checkout_configured ? t('settings.payments.wizard.kept', 'Saved value kept') : t('settings.payments.wizard.missing', 'Not entered')}</dd>
          <dt className="text-soft">{t('settings.payments.webhookSecret', 'Webhook signing secret')}</dt>
          <dd className="text-body">{webhookSecret.trim() ? t('settings.payments.wizard.entered', 'New value entered') : data.webhook_configured ? t('settings.payments.wizard.kept', 'Saved value kept') : t('settings.payments.wizard.missing', 'Not entered')}</dd>
        </dl>
        {isDirty && <p className="text-sm text-warning-text">{canSave
          ? t('settings.payments.wizard.saveBeforeCheck', 'Save your changes before checking access.')
          : t('settings.payments.wizard.bothRequired', 'Enter both credentials before saving for the first time.')}</p>}
        {(currentCheck?.account_id || data.account_id) && <p className="text-sm text-soft">{t('settings.payments.account', 'Stripe account: {{account}}', { account: currentCheck?.account_id || data.account_id })}</p>}
        <Button variant="outline" disabled={!data.checkout_configured || isDirty || save.isPending || test.isPending} isLoading={test.isPending} onClick={() => test.mutate()}>
          {t('settings.payments.checkApi', 'Check saved API access')}
        </Button>
        {apiChecked && <p role="status" className="text-sm text-body">{t('settings.payments.apiChecked', 'The saved API key passed read-only Account and Checkout Sessions checks.')}</p>}
        <p className="text-sm text-soft">{t('settings.payments.checkLimit', 'This check creates no payments. It does not verify write permissions, refunds, or webhook delivery. Save any changes before checking.')}</p>
      </>}
      {step === 4 && <>
        <p className="text-sm text-soft">{t('settings.payments.wizard.testHelp', 'In a Stripe sandbox, open a priced gallery using its normal shared link, not admin preview. Place a test order, check the buyer email, and download an original. Refund the order in Stripe and confirm the same link no longer downloads it. Also test cancelling a checkout.')}</p>
        {stripeLink('https://docs.stripe.com/testing#cards', t('settings.payments.wizard.testDetails', 'Stripe test payment details'))}
        <Notice tone={data.webhook_verified_at ? 'info' : 'warning'} title={data.webhook_verified_at ? t('settings.payments.webhookSeen', 'Signed webhook received') : t('settings.payments.webhookUnseen', 'No signed webhook received for these credentials')}>
          {data.webhook_verified_at ? t('settings.payments.webhookSeenHelp', 'A signature for the current credentials was verified at {{time}}. Confirm order fulfilment separately with a test purchase.', { time: formatDateTime(data.webhook_verified_at) }) : t('settings.payments.webhookUnseenHelp', 'Saving a signing secret does not prove delivery works. Complete a test checkout or send a test event from Stripe, then refresh this page.')}
        </Notice>
        <Button variant="outline" isLoading={query.isFetching} onClick={() => void query.refetch()}>{t('settings.payments.wizard.refresh', 'Refresh notification status')}</Button>
        <Notice tone="info" title={t('settings.payments.wizard.beforeLive', 'Before accepting real payments')}>
          {t('settings.payments.wizard.liveHelp', 'Finish Stripe’s business and bank verification. After testing, resolve outstanding sandbox checkouts, then repeat the key and notification steps in live mode using the same business account. Live keys collect real money; keep live access for refunds and disputes.')}
        </Notice>
      </>}
      <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
        <Button variant="outline" disabled={step === 0 || save.isPending} onClick={() => setStep((value) => value - 1)}>{t('settings.payments.wizard.back', 'Previous step')}</Button>
        {step < steps.length - 1 && <Button disabled={save.isPending} onClick={() => setStep((value) => value + 1)}>{t('settings.payments.wizard.next', 'Next step')}</Button>}
      </div>
    </div></Card>
    {!pinned && <SettingsSaveBar isDirty={isDirty} isSaving={save.isPending} canSave={canSave} onDiscard={discard}
      onSave={() => save.mutate({ revision: draftRevision || data.revision, ...(secretKey.trim() ? { secret_key: secretKey.trim() } : {}), ...(webhookSecret.trim() ? { webhook_secret: webhookSecret.trim() } : {}) })} />}
  </div>;
};
