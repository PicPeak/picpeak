import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  productUsageService as service,
  type ProductFeedback
} from '../../../services/productUsage.service';
import { ExternalLink } from 'lucide-react';
import { useConfirm } from '../../../components/common/ConfirmDialog';
import { Button, Card } from '../../../components/common';
import { UsageCatalog } from '../UsageCatalog';
import { ProductUsageConsentDialog } from '../components/ProductUsageConsentDialog';

// `.btn` is whitespace-nowrap and `.btn-md` a fixed 2.5rem tall — right for
// short labels, wrong for the sentence-length ones in this tab, which ran off
// the card at 390px and then, once allowed to wrap, out of the fixed height.
// h-auto lets the second line have somewhere to go; min-h keeps a one-line
// button the same size as every other button beside it.
const WRAPPING_BUTTON = 'max-w-full whitespace-normal text-left h-auto min-h-[2.5rem]';

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
  const [named, setNamed] = useState(false);
  // Set only when the browser refused the tab (popup blocked): the session
  // URL is then offered as a plain link the operator can click instead.
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
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
  const download = (value: unknown, filename = 'picpeak-usage-packets.json') => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (isPending) return <p>{t('productUsage.loading')}</p>;
  if (isError || !data) return <p role="alert">{t('productUsage.failed')}</p>;
  const active = data.status === 'active';
  // Signed-in portal access without the credential ever touching a URL that
  // a server sees. The backend asks the collector for a short-lived session
  // (a signed `session` command, so the collector knows which installation
  // this is), and the portal is opened with that token in the URL *fragment*:
  // fragments are never sent over the wire, and the portal drops it from the
  // address bar on load and keeps the session in memory only. The lookup
  // hash itself never leaves the settings page.
  //
  // The tab is opened synchronously in the click handler and navigated once
  // the session exists — opening it after the await trips popup blockers.
  // Navigation goes through a document written into the blank tab rather
  // than `tab.location`: a script-initiated navigation carries the admin
  // page as referrer, and the collector must not learn this installation's
  // origin. The written page declares no-referrer and refreshes itself.
  //
  // If the browser refused the tab, the URL is kept as a plain link instead
  // of a second window.open after the await, which would be refused too. If
  // the collector cannot be reached the session command is queued for retry
  // and the tab falls back to the public portal, so the click still lands
  // somewhere.
  const openPortal = () => {
    if (!data.collector_url) return;
    setPortalUrl(null);
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    const go = (url: string) => {
      if (!tab) {
        setPortalUrl(url);
        return;
      }
      const escaped = url.replace(/"/g, '&quot;');
      tab.document.open();
      tab.document.write(
        `<!doctype html><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${escaped}">`
      );
      tab.document.close();
    };
    return run(async () => {
      try {
        const result = await service.portalSession();
        if (result.url) {
          go(result.url);
        } else {
          go(data.collector_url as string);
          if (!result.delivered) setMessage(t('productUsage.queued'));
        }
      } catch (error) {
        tab?.close();
        throw error;
      }
    });
  };
  return (
    <div className="space-y-6 text-theme">
      <p>{t('productUsage.purpose')}</p>
      <Card padding="md" className="space-y-4">
        <h3 className="text-lg font-semibold text-heading">
          {t(`productUsage.states.${data.status}`)}
        </h3>
        <p>{t(`productUsage.stateDetails.${data.status}`)}</p>
        {data.status !== 'disabled' && <p>{t('productUsage.currentSchema', { schema: data.schema_version })}</p>}
        {data.consent_update_available && (
          <div className="rounded border border-theme p-3 space-y-2">
            <p>{t('productUsage.upgradeExplanation')}</p>
            <Button disabled={busy || Boolean(data.pending_action) || !data.collector_url} onClick={() => setConsent(true)}>
              {t('productUsage.reviewUpgrade')}
            </Button>
          </div>
        )}
        {data.pending_action === 'consent' && <p role="status">{t('productUsage.upgradePending')}</p>}
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
                : data.last_error === 'SCHEMA_NOT_ACCEPTED'
                  ? 'productUsage.schemaNotAccepted'
                  : 'productUsage.deliveryProblem'
            )}
          </p>
        )}
        {data.retry_after && (
          // A paced install is waiting, not broken. Without this the tab shows
          // a delivery error and an idle Retry button, and nothing says the
          // sender is going to try again on its own.
          <p role="status" className="text-sm text-soft">
            {t('productUsage.retryScheduled', {
              time: new Date(data.retry_after).toLocaleTimeString()
            })}
          </p>
        )}
        {data.can_abandon && (
          // The one dead end the operator cannot retry out of. Offered only
          // here, and worded so nobody mistakes it for a confirmed deletion.
          <div className="rounded border border-amber-300 dark:border-amber-700 p-3 space-y-2">
            <p>
              {t(
                data.abandon_never_registered
                  ? 'productUsage.abandonExplanationUnregistered'
                  : 'productUsage.abandonExplanation'
              )}
            </p>
            <Button
              variant="outline"
              className={WRAPPING_BUTTON}
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: t('productUsage.abandon'),
                    message: t(
                      data.abandon_never_registered
                        ? 'productUsage.abandonConfirmUnregistered'
                        : 'productUsage.abandonConfirm'
                    ),
                    confirmLabel: t('productUsage.abandon'),
                    variant: 'danger'
                  })
                ) {
                  await run(async () => {
                    await service.abandon();
                    setPreview(null);
                  });
                }
              }}
            >
              {t('productUsage.abandon')}
            </Button>
          </div>
        )}
        {active && data.pending_action && data.pending_action !== 'consent' && (
          // The portal button below (and the v5-upgrade button above, when
          // present) are disabled by the same pending-packet guard the
          // backend enforces (command() refuses a second packet while one is
          // still unacknowledged) — without this note they just look broken,
          // and "Retry" above isn't obviously the fix. Gated on `active`:
          // outside that status the portal renders as a plain, un-gated link
          // and no v5-upgrade section exists, so pending_action blocks
          // nothing this note could correctly describe (e.g.
          // activation_pending/deletion_pending with their own packet still
          // in flight). Which controls it names depends on whether the
          // v5-upgrade section is actually on screen.
          <p role="status" className="text-sm text-soft">
            {t(data.consent_update_available ? 'productUsage.pendingBlocksActions' : 'productUsage.pendingBlocksPortal')}
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
                    });
                  }
                }}
              >
                {t('productUsage.disable')}
              </Button>
            </>
          )}
          {data.collector_url && (
            <>
              {/* One button, two behaviours. Before participation it is a plain
                  link: the portal is public and an operator deciding whether
                  to join should be able to look at it first. While
                  participating it opens the portal signed in — see openPortal
                  above — so nobody has to copy the lookup hash around. */}
              {active ? (
                <>
                  <Button
                    disabled={busy || Boolean(data.pending_action)}
                    onClick={openPortal}
                  >
                    {t('productUsage.openUsagePortal')}
                    <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Button>
                  {portalUrl && (
                    <a
                      href={portalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary-600 dark:text-primary-400 hover:underline self-center"
                    >
                      {t('productUsage.portalReady')}
                    </a>
                  )}
                </>
              ) : (
                <a
                  className="btn btn-primary btn-md"
                  href={data.collector_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('productUsage.openUsagePortal')}
                  <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                </a>
              )}
              <a
                className="text-sm text-primary-600 dark:text-primary-400 hover:underline self-center"
                href={`${data.collector_url}/transparency`}
                target="_blank"
                rel="noreferrer"
              >
                {t('productUsage.transparency')}
              </a>
            </>
          )}
        </div>
      </Card>
      <UsageCatalog />
      {data.privacy_receipts &&
        Object.keys(data.privacy_receipts).length > 0 && (
          <Card padding="md" className="space-y-4">
            <h3 className="text-lg font-semibold">
              {t('productUsage.auditTitle')}
            </h3>
            <p>{t('productUsage.auditDescription')}</p>
            {/* The receipts outlive the participation they describe: rejoining
                does not clear them, so an active install would otherwise show
                a bare "deletion confirmed" next to its own live participation
                and read as a contradiction. */}
            {active &&
              Boolean(
                data.privacy_receipts.last_deletion ||
                  data.privacy_receipts.last_abandonment
              ) && (
                <p className="text-sm text-soft">
                  {t('productUsage.auditPreviousParticipation')}
                </p>
              )}
            <Button
              variant="outline"
              onClick={() =>
                download(
                  data.privacy_receipts,
                  'picpeak-usage-privacy-receipts.json'
                )
              }
            >
              {t('productUsage.auditDownload')}
            </Button>
          </Card>
        )}
      {active && (
        <>
          <Card padding="md" className="space-y-4">
            <h3 className="text-lg font-semibold text-heading">
              {t('productUsage.inspect')}
            </h3>
            {/* `.btn` sets whitespace-nowrap, and these labels are long
                sentences in both locales — at 390px two of them ran past the
                card and their text was simply cut off. Allowed to wrap and
                capped at the container width instead. */}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                className={WRAPPING_BUTTON}
                disabled={busy}
                onClick={() =>
                  run(async () => setPreview(await service.preview()))
                }
              >
                {t('productUsage.preview')}
              </Button>
              <Button
                variant="outline"
                className={WRAPPING_BUTTON}
                disabled={busy || !data.last_packet}
                onClick={() => setPreview(data.last_packet)}
              >
                {t('productUsage.lastPacket')}
              </Button>
              <Button
                variant="outline"
                className={WRAPPING_BUTTON}
                disabled={busy}
                onClick={() =>
                  run(async () => download(await service.export()))
                }
              >
                {t('productUsage.export')}
              </Button>
            </div>
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
            <h3 className="text-lg font-semibold text-heading">
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
        <ProductUsageConsentDialog
          upgrade={active}
          collector={data.collector_url ?? ''}
          busy={busy}
          close={() => setConsent(false)}
          enable={() =>
            run(async () => {
              if (active) {
                const result = await service.upgradeConsent();
                if (!result.delivered) setMessage(t('productUsage.queued'));
                setPreview(null);
              } else await service.enable();
              setConsent(false);
            })
          }
        />
      )}
    </div>
  );
}
