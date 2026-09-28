import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpFromLine, Globe, ListChecks, MessageSquare, Send, ShieldOff, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '../../../components/common/Button';
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

export function ProductUsageConsentDialog({
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
  const titleId = useId();
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
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      tabIndex={-1}
      aria-labelledby={titleId}
      // Column layout with its own scroll region, so the title stays put and
      // the actions never scroll out of reach on a short screen.
      //
      // Surface is class-driven rather than `bg-theme-surface`: that variable
      // does not follow dark mode, so it stayed white while the dark: text
      // variants below turned near-white. neutral-800 is what `.card`
      // resolves to in dark, which is what the rest of the admin UI uses.
      className="w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden rounded-xl p-0 bg-panel text-heading shadow-xl backdrop:bg-black/50 focus:outline-none"
    >
      <header className="flex items-start gap-3 px-6 pt-6 pb-4">
        <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary-50 dark:bg-primary-900/30">
          <Sparkles className="h-5 w-5 text-primary-600 dark:text-primary-300" />
        </span>
        <div className="min-w-0">
          <h2
            id={titleId}
            className="text-lg font-semibold text-heading"
          >
            {t('productUsage.consentTitle')}
          </h2>
          <p className="mt-1 text-sm text-soft">
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
        className="min-h-0 flex-auto overflow-y-auto border-y border-line px-6 py-4 space-y-4 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary-400"
      >
        {DISCLOSURE.map(({ key, heading, Icon }) => (
          <section key={key}>
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              <Icon className="h-3.5 w-3.5" />
              {t(`productUsage.${heading}`)}
            </h3>
            <p className="mt-1 text-sm text-body">
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
        <label className="flex items-start gap-2.5 text-sm text-body">
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
          <Button onClick={enable} disabled={!checked || busy || !collector}>
            {t(upgrade ? 'productUsage.upgrade' : 'productUsage.enable')}
          </Button>
        </div>
      </footer>
    </dialog>
  );
}
