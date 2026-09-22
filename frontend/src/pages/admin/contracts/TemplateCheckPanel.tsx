/**
 * The result of a contract template's pre-publication check (#1445): each
 * finding in words, errors before warnings, with a "Go to" that takes the
 * admin to the clause, text or attachment it is about. Errors block
 * publishing; warnings are shown and don't.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { TemplateFinding, TemplatePublishCheck } from '../../../services/contractTemplates.service';

export interface FindingLabels {
  /** The clause at a 1-based position, as the editor names it. */
  clauseName: (position: number) => string | null;
  attachmentName: (attachmentId: number) => string | null;
}

export const TemplateCheckPanel: React.FC<{
  check: TemplatePublishCheck;
  labels: FindingLabels;
  onGoTo: (finding: TemplateFinding) => void;
  /** The draft changed since the check ran. */
  stale?: boolean;
}> = ({ check, labels, onGoTo, stale = false }) => {
  const { t } = useTranslation();
  const errors = check.findings.filter((f) => f.severity === 'error');
  const warnings = check.findings.filter((f) => f.severity === 'warning');

  const where = (f: TemplateFinding): string => {
    if (f.field === 'intro') return t('contracts.templates.introText', 'Intro text') as string;
    if (f.field === 'outro') return t('contracts.templates.outroText', 'Closing text') as string;
    if (f.itemPosition) {
      const name = labels.clauseName(f.itemPosition);
      return t('contracts.templates.check.clause', 'Clause {{position}}', { position: f.itemPosition })
        + (name ? ` · ${name}` : '');
    }
    return '';
  };

  const describe = (f: TemplateFinding): string => t(`contracts.templates.check.codes.${f.code}`, f.message, {
    where: where(f),
    locale: (f.locale || '').toUpperCase(),
    key: f.key ? (f.code === 'FONT_MISSING' ? f.key : `{{${f.key}}}`) : '',
    name: f.attachmentId ? (labels.attachmentName(f.attachmentId) || `#${f.attachmentId}`) : '',
    pages: check.pageCount ?? '',
  }) as string;

  const canGo = (f: TemplateFinding) => Boolean(f.itemPosition || f.field || f.attachmentId);

  const row = (f: TemplateFinding, index: number) => (
    <li key={`${f.code}-${index}`} className="flex items-start gap-2 text-sm">
      {f.severity === 'error'
        ? <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-700 dark:text-red-400" aria-hidden="true" />
        : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />}
      <span className="sr-only">
        {f.severity === 'error' ? t('contracts.templates.check.error', 'Error') : t('contracts.templates.check.warning', 'Warning')}:
      </span>
      <span className="flex-1 text-neutral-800 dark:text-neutral-200">{describe(f)}</span>
      {canGo(f) && (
        <button type="button" onClick={() => onGoTo(f)}
          className="text-xs underline text-primary-700 dark:text-primary-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 rounded px-1">
          {t('contracts.templates.check.goTo', 'Go to')}
        </button>
      )}
    </li>
  );

  return (
    <section
      aria-labelledby="contract-template-check-heading"
      className={`p-3 rounded-md border text-sm ${errors.length
        ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30'
        : 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30'}`}
    >
      <div className="flex items-center gap-2 flex-wrap mb-2">
        {errors.length === 0 && <CheckCircle2 className="w-4 h-4 text-green-700 dark:text-green-400" aria-hidden="true" />}
        <h2 id="contract-template-check-heading" className="font-semibold text-neutral-900 dark:text-neutral-100">
          {errors.length
            ? t('contracts.templates.check.blocked', 'Fix these before publishing')
            : t('contracts.templates.check.passed', 'Ready to publish')}
        </h2>
        {check.pageCount != null && (
          <span className="text-neutral-600 dark:text-neutral-400">
            {t('contracts.templates.check.pageCount', '{{count}} pages in the dry run', { count: check.pageCount })}
          </span>
        )}
        {stale && (
          <span className="text-amber-800 dark:text-amber-300">
            {t('contracts.templates.check.stale', 'Changed since the check — check again')}
          </span>
        )}
      </div>
      {check.findings.length > 0 && (
        <ul className="space-y-1" role="list">
          {errors.map(row)}
          {warnings.map((f, i) => row(f, errors.length + i))}
        </ul>
      )}
    </section>
  );
};
