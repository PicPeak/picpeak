import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  productUsageService as service,
  type ProductFeedback
} from '../../../services/productUsage.service';
import { useConfirm } from '../../../components/common/ConfirmDialog';
import { Button, Card } from '../../../components/common';

function ConsentDialog({
  close,
  enable,
  busy,
  collector
}: {
  close: () => void;
  enable: () => void;
  busy: boolean;
  collector: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      aria-labelledby="usage-consent-title"
      className="w-full max-w-2xl rounded-xl p-6 text-theme bg-theme-surface backdrop:bg-black/50"
    >
      <h2 id="usage-consent-title" className="text-xl font-semibold">
        {t('productUsage.consentTitle')}
      </h2>
      <div className="my-4 max-h-[55vh] overflow-y-auto space-y-3">
        {[
          'purpose',
          'fields',
          'excluded',
          'transport',
          'visibility',
          'deletion',
          'feedbackDisclosure'
        ].map((key) => (
          <p key={key}>{t(`productUsage.${key}`, { collector })}</p>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <a
          className={'text-primary-600 dark:text-primary-400 hover:underline'}
          href={collector}
          target="_blank"
          rel="noreferrer"
        >
          {t('productUsage.linkCollector')}
        </a>
        <a
          className={'text-primary-600 dark:text-primary-400 hover:underline'}
          href={`${collector}/transparency`}
          target="_blank"
          rel="noreferrer"
        >
          {t('productUsage.transparency')}
        </a>
      </div>
      <label className="flex items-start gap-2 mb-4">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        {t('productUsage.consentCheck')}
      </label>
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={close} disabled={busy}>
          {t('productUsage.cancel')}
        </Button>
        <Button onClick={enable} disabled={!checked || busy}>
          {t('productUsage.enable')}
        </Button>
      </div>
    </dialog>
  );
}

export default function ProductUsageTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data, isPending, isError } = useQuery({
    queryKey: ['productUsage'],
    queryFn: service.status,
    refetchInterval: 30000
  });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<unknown>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [named, setNamed] = useState(false);
  const [form, setForm] = useState<ProductFeedback>({
    kind: 'feedback',
    title: '',
    body: '',
    name: '',
    allow_public: false,
    allow_marketing: false
  });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch {
      setMessage(t('productUsage.failed'));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['productUsage'] });
    }
  };
  const download = (value: unknown) => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'picpeak-usage-packets.json';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (isPending) return <p>{t('productUsage.loading')}</p>;
  if (isError || !data) return <p role="alert">{t('productUsage.failed')}</p>;
  const active = data.status === 'active';
  return (
    <div className="space-y-6 text-theme">
      <p>{t('productUsage.purpose')}</p>
      <Card padding="md" className="space-y-4">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {t(`productUsage.states.${data.status}`)}
        </h3>
        <p>{t(`productUsage.stateDetails.${data.status}`)}</p>
        {data.installation_id && (
          <label className="block">
            {t('productUsage.hash')}
            <input
              className="mt-1 w-full rounded border border-theme bg-theme-surface p-2 font-mono text-sm"
              readOnly
              value={data.installation_id}
            />
          </label>
        )}
        {data.last_report_date && (
          <p>{t('productUsage.lastReport', { date: data.last_report_date })}</p>
        )}
        {data.collector_error === 'INVALID_COLLECTOR_URL' && (
          <p role="alert" className="text-amber-700 dark:text-amber-300">
            {/* Shown alongside the real controls, not instead of them: with a
                bad URL the operator still needs to read their status and
                still needs to be able to withdraw. */}
            {t('productUsage.invalidCollectorUrl')}
          </p>
        )}
        {data.last_error && (
          <p role="status">
            {/* Retrying cannot fix an unreadable signing key, and neither can
                disabling: without the original encryption material the
                deletion request cannot be signed either. Telling the operator
                to retry would send them in a circle. */}
            {t(
              data.last_error === 'SIGNING_KEY_UNREADABLE'
                ? 'productUsage.signingKeyUnreadable'
                : 'productUsage.deliveryProblem'
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {data.status === 'disabled' ? (
            <Button disabled={busy} onClick={() => setConsent(true)}>
              {t('productUsage.review')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await service.retry();
                  })
                }
              >
                {t('productUsage.retry')}
              </Button>
              <Button
                variant="outline"
                disabled={busy || data.status === 'deletion_pending'}
                onClick={async () => {
                  if (
                    await confirm({
                      title: t('productUsage.disable'),
                      message: t('productUsage.deletion'),
                      confirmLabel: t('productUsage.disable'),
                      variant: 'danger'
                    })
                  ) {
                    await run(async () => {
                      await service.disable();
                      setPreview(null);
                      setPortalUrl(null);
                    });
                  }
                }}
              >
                {t('productUsage.disable')}
              </Button>
            </>
          )}
          {data.collector_url && (
            <a
              className="text-sm text-primary-600 dark:text-primary-400 hover:underline self-center"
              href={`${data.collector_url}/transparency`}
              target="_blank"
              rel="noreferrer"
            >
              {t('productUsage.transparency')}
            </a>
          )}
        </div>
      </Card>
      {active && (
        <>
          <Card padding="md" className="space-y-4">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('productUsage.inspect')}
            </h3>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => setPreview(await service.preview()))
                }
              >
                {t('productUsage.preview')}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !data.last_packet}
                onClick={() => setPreview(data.last_packet)}
              >
                {t('productUsage.lastPacket')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => download(await service.export()))
                }
              >
                {t('productUsage.export')}
              </Button>
              <Button
                variant="outline"
                disabled={busy || Boolean(data.pending_action)}
                onClick={() =>
                  run(async () => {
                    const result = await service.portalSession();
                    setPortalUrl(result.url);
                    if (!result.delivered) setMessage(t('productUsage.queued'));
                  })
                }
              >
                {t('productUsage.connect')}
              </Button>
            </div>
            {portalUrl && (
              <a
                href={portalUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {t('productUsage.openPortal')}
              </a>
            )}
            {preview !== null && (
              <pre
                className="max-h-96 overflow-auto rounded border border-theme p-3 text-xs"
                aria-label={t('productUsage.preview')}
              >
                {JSON.stringify(preview, null, 2)}
              </pre>
            )}
          </Card>
          <Card padding="md">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await service.feedback({
                  ...form,
                  name: named ? form.name : ''
                });
                setMessage(
                  t(
                    result.delivered
                      ? 'productUsage.feedbackSent'
                      : result.queued
                        ? 'productUsage.queued'
                        : 'productUsage.failed'
                  )
                );
                // Every consent choice resets with the item it was made for.
                // Leaving `named` checked meant the next submission carried
                // the previous name automatically, which contradicts the
                // per-item, anonymous-by-default promise the disclosure makes
                // — the remembered name stays in preferences, but attaching
                // it is a decision taken again each time.
                setNamed(false);
                setForm({
                  ...form,
                  title: '',
                  body: '',
                  allow_public: false,
                  allow_marketing: false
                });
              });
            }}
          >
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('productUsage.feedbackTitle')}
            </h3>
            <p>{t('productUsage.feedbackDisclosure')}</p>
            <label className="block">
              {t('productUsage.kind')}
              <select
                aria-label={t('productUsage.kind')}
                className="block mt-1 rounded border border-theme bg-theme-surface p-2"
                value={form.kind}
                onChange={(e) =>
                  setForm({
                    ...form,
                    kind: e.target.value as ProductFeedback['kind'],
                    allow_public: false,
                    allow_marketing: false
                  })
                }
              >
                {['feedback', 'feature_request', 'testimonial'].map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`productUsage.kinds.${kind}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              {t('productUsage.subject')}
              <input
                required
                maxLength={120}
                className="block mt-1 w-full rounded border border-theme bg-theme-surface p-2"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <label className="block">
              {t('productUsage.message')}
              <textarea
                required
                maxLength={4000}
                rows={5}
                className="block mt-1 w-full rounded border border-theme bg-theme-surface p-2"
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
              />
            </label>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={named}
                onChange={(e) => {
                  setNamed(e.target.checked);
                  if (e.target.checked && !form.name)
                    setForm({ ...form, name: data.feedback_preferences.name });
                }}
              />
              {t('productUsage.includeName')}
            </label>
            {named && (
              <div className="space-y-2">
                <label className="block">
                  {t('productUsage.name')}
                  <input
                    required
                    maxLength={80}
                    className="block mt-1 rounded border border-theme bg-theme-surface p-2"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await service.preferences(form.name);
                      setMessage(t('productUsage.saved'));
                    })
                  }
                >
                  {t('productUsage.saveName')}
                </Button>
              </div>
            )}
            {form.kind !== 'feedback' && (
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={form.allow_public}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      allow_public: e.target.checked,
                      allow_marketing: false
                    })
                  }
                />
                {t('productUsage.allowPublic')}
              </label>
            )}
            {form.kind === 'testimonial' && (
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={form.allow_marketing}
                  disabled={!form.allow_public}
                  onChange={(e) =>
                    setForm({ ...form, allow_marketing: e.target.checked })
                  }
                />
                {t('productUsage.allowMarketing')}
              </label>
            )}
            <Button
              type="submit"
              disabled={busy || Boolean(data.pending_action)}
            >
              {t('productUsage.sendFeedback')}
            </Button>
          </form>
          </Card>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {consent && (
        <ConsentDialog
          collector={data.collector_url ?? ''}
          busy={busy}
          close={() => setConsent(false)}
          enable={() =>
            run(async () => {
              await service.enable();
              setConsent(false);
            })
          }
        />
      )}
    </div>
  );
}
