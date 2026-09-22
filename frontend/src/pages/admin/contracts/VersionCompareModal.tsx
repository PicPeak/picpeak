/**
 * Two versions of a contract template side by side as changes (#1445):
 * title, intro and closing text, each clause (added / removed / moved /
 * changed, word by word), and the attachments. Used for "Compare with
 * previous" in the version history and for an edit conflict (the server's
 * draft against the one in the editor).
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ContractModal } from './ContractModal';
import { diffVersions, type ComparableVersion, type TextChange } from './templateDiff';

const badge: Record<string, string> = {
  added: 'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200',
  removed: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  moved: 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200',
  changed: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
};

const Texts: React.FC<{ texts: TextChange[] }> = ({ texts }) => (
  <div className="space-y-1">
    {texts.map(({ locale, ops }) => (
      <p key={locale} className="text-sm whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">
        <span className="mr-2 text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400">{locale}</span>
        {ops.map((op, i) => {
          if (op.type === 'add') return <ins key={i} className="bg-green-100 dark:bg-green-900/50 no-underline">{op.text}</ins>;
          if (op.type === 'del') return <del key={i} className="bg-red-100 dark:bg-red-900/50">{op.text}</del>;
          return <span key={i}>{op.text}</span>;
        })}
      </p>
    ))}
  </div>
);

export const VersionCompareModal: React.FC<{
  before: ComparableVersion;
  after: ComparableVersion;
  title: string;
  /** e.g. "v2 → v3", "Saved by someone else → yours". */
  subtitle?: string;
  onClose: () => void;
  footer?: React.ReactNode;
}> = ({ before, after, title, subtitle, onClose, footer }) => {
  const { t } = useTranslation();
  const diff = useMemo(() => diffVersions(before, after), [before, after]);
  const fieldLabel = {
    title: t('contracts.templates.docTitle', 'Contract title'),
    intro: t('contracts.templates.introText', 'Intro text'),
    outro: t('contracts.templates.outroText', 'Closing text'),
  };
  const typeLabel = (type: string) => t(`contracts.templates.compare.types.${type}`, type);

  return (
    <ContractModal titleId="contract-template-compare-title" title={title} onClose={onClose} footer={footer}>
      {subtitle && <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">{subtitle}</p>}
      {diff.unchanged && (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{t('contracts.templates.compare.none', 'No differences.')}</p>
      )}
      <div className="space-y-4">
        {diff.fields.map((f) => (
          <section key={f.field} className="space-y-1">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{fieldLabel[f.field]}</h3>
            <Texts texts={f.texts} />
          </section>
        ))}
        {diff.clauses.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('contracts.templates.clauses', 'Clauses')}</h3>
            <ul className="space-y-3">
              {diff.clauses.map((c, i) => (
                <li key={`${c.type}-${c.from}-${c.to}-${i}`} className="rounded border border-neutral-200 dark:border-neutral-700 p-2">
                  <div className="flex flex-wrap items-center gap-2 mb-1 text-sm">
                    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${badge[c.type]}`}>{typeLabel(c.type)}</span>
                    {c.moved && <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${badge.moved}`}>{typeLabel('moved')}</span>}
                    <span className="font-medium text-neutral-900 dark:text-neutral-100">{c.name || t('contracts.templates.untitled', 'Untitled')}</span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {c.from != null && c.to != null && c.from !== c.to
                        ? t('contracts.templates.compare.position', 'position {{from}} → {{to}}', { from: c.from, to: c.to })
                        : t('contracts.templates.compare.at', 'position {{position}}', { position: c.to ?? c.from })}
                    </span>
                  </div>
                  {c.type !== 'moved' && <Texts texts={c.texts} />}
                </li>
              ))}
            </ul>
          </section>
        )}
        {diff.attachments.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('contracts.attachments.heading', 'Attachments')}</h3>
            <ul className="text-sm space-y-1">
              {diff.attachments.map((a) => (
                <li key={`${a.type}-${a.name}`} className="flex items-center gap-2">
                  <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${badge[a.type]}`}>{typeLabel(a.type)}</span>
                  <span className="text-neutral-800 dark:text-neutral-200">{a.name}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </ContractModal>
  );
};
