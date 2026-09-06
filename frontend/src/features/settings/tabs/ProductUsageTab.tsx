import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  productUsageService as service,
  type ProductFeedback
} from '../../../services/productUsage.service';
import {
  ArrowUpFromLine,
  Globe,
  ListChecks,
  MessageSquare,
  Send,
  ShieldOff,
  Sparkles,
  Trash2
} from 'lucide-react';
import { useConfirm } from '../../../components/common/ConfirmDialog';
import { Button, Card } from '../../../components/common';
import { UsageCatalog } from '../UsageCatalog';

/**
 * Sections of the disclosure, in reading order. Each is a translated
 * paragraph; the heading and icon give it a shape you can scan instead of
 * seven identical blocks of prose.
 */
const DISCLOSURE: {
  key: string;
  heading: string;
  Icon: ComponentType<{ className?: string }>;
}[] = [
  { key: 'fields', heading: 'sectionFields', Icon: ListChecks },
  { key: 'excluded', heading: 'sectionExcluded', Icon: ShieldOff },
  { key: 'transport', heading: 'sectionTransport', Icon: Send },
  // Directly after transport, because it is a property of the transport and
  // the reason the transport is shaped this way: the connection only ever
  // runs outwards, so this cannot become a way to push anything in.
  { key: 'oneWay', heading: 'sectionOneWay', Icon: ArrowUpFromLine },
  { key: 'visibility', heading: 'sectionVisibility', Icon: Globe },
  { key: 'deletion', heading: 'sectionDeletion', Icon: Trash2 },
  { key: 'feedbackDisclosure', heading: 'sectionFeedback', Icon: MessageSquare }
];

// `.btn` is whitespace-nowrap and `.btn-md` a fixed 2.5rem tall — right for
// short labels, wrong for the sentence-length ones in this tab, which ran off
// the card at 390px and then, once allowed to wrap, out of the fixed height.
// h-auto lets the second line have somewhere to go; min-h keeps a one-line
// button the same size as every other button beside it.
const WRAPPING_BUTTON = 'max-w-full whitespace-normal text-left h-auto min-h-[2.5rem]';

function ConsentDialog({
  close,
  enable,
  busy,
  collector,
  upgrade = false
}: {
  close: () => void;
  enable: () => void;
  busy: boolean;
  collector: string;
  upgrade?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    // React unmounts this <dialog> on close rather than only closing it, so
    // the focus restoration showModal() normally performs has nothing left to
    // return to and focus drops to <body> — a keyboard user is thrown back to
    // the top of the page every time they cancel (WCAG 2.4.3). Remember the
    // opener and put focus back by hand.
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    // showModal() focuses the first focusable descendant, which is the scroll
    // region below — so its focus ring was drawn for everyone the moment the
    // dialog opened, and because the dialog clips its sides an inset ring
    // reads as two coloured bars across the disclosure rather than a ring.
    // Focusing the dialog puts the ring back where it belongs: only when
    // someone deliberately tabs to the region.
    ref.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      tabIndex={-1}
      aria-labelledby="usage-consent-title"
      // Column layout with its own scroll region, so the title stays put and
      // the actions never scroll out of reach on a short screen.
      //
      // Surface is class-driven rather than `bg-theme-surface`: that variable
      // does not follow dark mode, so it stayed white while the dark: text
      // variants below turned near-white. neutral-800 is what `.card`
      // resolves to in dark, which is what the rest of the admin UI uses.
      className="w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden rounded-xl p-0 bg-white dark:bg-neutral-800 shadow-xl backdrop:bg-black/50 focus:outline-none"
    >
      <header className="flex items-start gap-3 px-6 pt-6 pb-4">
        <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary-50 dark:bg-primary-900/30">
          <Sparkles className="h-5 w-5 text-primary-600 dark:text-primary-300" />
        </span>
        <div className="min-w-0">
          <h2
            id="usage-consent-title"
            className="text-lg font-semibold text-neutral-900 dark:text-neutral-100"
          >
            {t('productUsage.consentTitle')}
          </h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {t('productUsage.purpose')}
          </p>
        </div>
      </header>

      {/* A scrollable region is focusable, which is correct for keyboard use —
          but unstyled it drew a default ring that made the disclosure look
          like a textarea. Given a real label and ring so it reads as what it
          is: a document you can scroll. */}
      <div
        tabIndex={0}
        role="group"
        aria-label={t('productUsage.consentTitle') as string}
        className="flex-1 overflow-y-auto border-y border-neutral-200 dark:border-neutral-700 px-6 py-4 space-y-4 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary-400"
      >
        {DISCLOSURE.map(({ key, heading, Icon }) => (
          <section key={key}>
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              <Icon className="h-3.5 w-3.5" />
              {t(`productUsage.${heading}`)}
            </h3>
            <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
              {t(`productUsage.${key}`, { collector })}
            </p>
          </section>
        ))}
        <p className="text-sm">{t('productUsage.versionDisclosure')}</p>
        <UsageCatalog />

        <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-sm">
          <a
            className="text-primary-600 dark:text-primary-400 hover:underline"
            href={collector}
            target="_blank"
            rel="noreferrer"
          >
            {t('productUsage.linkCollector')}
          </a>
          <a
            className="text-primary-600 dark:text-primary-400 hover:underline"
            href={`${collector}/transparency`}
            target="_blank"
            rel="noreferrer"
          >
            {t('productUsage.transparency')}
          </a>
        </div>
      </div>

      <footer className="px-6 pt-4 pb-6 space-y-4">
        <label className="flex items-start gap-2.5 text-sm text-neutral-800 dark:text-neutral-200">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 flex-none"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>{t('productUsage.consentCheck')}</span>
        </label>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={close} disabled={busy}>
            {t('productUsage.cancel')}
          </Button>
          <Button onClick={enable} disabled={!checked || busy}>
            {t(upgrade ? 'productUsage.upgrade' : 'productUsage.enable')}
          </Button>
        </div>
      </footer>
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
  return (
    <div className="space-y-6 text-theme">
      <p>{t('productUsage.purpose')}</p>
      <Card padding="md" className="space-y-4">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
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
          <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">
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
                    setPortalUrl(null);
                  });
                }
              }}
            >
              {t('productUsage.abandon')}
            </Button>
          </div>
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
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
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
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
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
              <Button
                variant="outline"
                className={WRAPPING_BUTTON}
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
