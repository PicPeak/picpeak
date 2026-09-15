/**
 * Settings → Branding: the PDF theme for quotes, invoices and contracts
 * (#1445). "All documents" holds the defaults; each document type can
 * override any of them. An empty field inherits — from "All documents",
 * then the business profile (the PDF font above, folding marks), then the
 * built-in look. Saved on its own, separate from the page's Save button,
 * and previewed with a sample document from the real PDF pipeline.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card } from '../common';
import { PermissionGate } from './PermissionGate';
import {
  pdfThemesService,
  type PdfColorKey, type PdfFooterMode, type PdfFoldingMarks, type PdfPageNumbers,
  type PdfThemeScope, type PdfThemeSettings,
} from '../../services/pdfThemes.service';

const SCOPES: PdfThemeScope[] = ['default', 'quote', 'invoice', 'contract'];
const COLOR_KEYS: PdfColorKey[] = ['text', 'accent', 'muted', 'subtle', 'rule'];
const TITLE_SIZES = [14, 16, 18, 20, 22, 24, 26, 28];
const FOOTER_MODES: PdfFooterMode[] = ['address', 'custom', 'none'];
const PAGE_NUMBERS: PdfPageNumbers[] = ['bottom-right', 'bottom-center', 'none'];
const FOLDING_MARKS: PdfFoldingMarks[] = ['none', 'half', 'third', 'both'];
const HEX = /^#[0-9a-f]{6}$/i;

const fieldClass = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 '
  + 'bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100';
const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';

function errorMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

export const PdfThemeCard: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<PdfThemeScope>('default');
  const [draft, setDraft] = useState<PdfThemeSettings>({});
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({ queryKey: ['pdf-themes'], queryFn: () => pdfThemesService.list() });
  const row = data?.themes.find((th) => th.scope === scope);
  const resolved = row?.resolved;

  // Load the scope's stored settings whenever the scope or the saved data changes.
  useEffect(() => {
    setDraft(row?.settings ? { ...row.settings } : {});
  }, [row?.settings, scope]);

  const setColor = (key: PdfColorKey, value: string | null) => setDraft((d) => {
    const colors: Partial<Record<PdfColorKey, string>> = { ...(d.colors || {}) };
    if (value) colors[key] = value; else delete colors[key];
    const next: PdfThemeSettings = { ...d, colors };
    if (Object.keys(colors).length === 0) delete next.colors;
    return next;
  });
  const setField = <K extends keyof PdfThemeSettings>(key: K, value: PdfThemeSettings[K] | undefined) => setDraft((d) => {
    const next = { ...d };
    if (value === undefined) delete next[key]; else next[key] = value;
    return next;
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pdf-themes'] });

  const save = async (settings: PdfThemeSettings) => {
    setBusy(true);
    try {
      await pdfThemesService.save(scope, settings);
      await refresh();
      toast.success(t('branding.pdfTheme.saved', 'PDF theme saved'));
    } catch (err) {
      toast.error(errorMessage(err) || t('branding.pdfTheme.saveFailed', 'Could not save the PDF theme'));
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setBusy(true);
    try {
      const url = await pdfThemesService.previewUrl(scope, draft);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorMessage(err) || t('branding.pdfTheme.previewFailed', 'Could not render the preview'));
    } finally {
      setBusy(false);
    }
  };

  const inherit = (value: string | number) => t('branding.pdfTheme.inherit', 'Inherit ({{value}})', { value });
  const familyLabel = (dir: string) => dir.replace(/-/g, ' ');
  const footerMode = draft.footer?.mode;

  return (
    <Card padding="md" className="mb-6">
      <div className="flex items-start gap-3 mb-4">
        <FileText className="w-5 h-5 mt-0.5 text-neutral-600 dark:text-neutral-300" aria-hidden />
        <div>
          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t('branding.pdfTheme.title', 'PDF theme')}
          </h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('branding.pdfTheme.description', 'Colours, font, footer and page numbers for quotes, invoices and contracts. Empty fields inherit from "All documents", then your business profile.')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label={t('branding.pdfTheme.scopeLabel', 'Document type') as string}>
        {SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={scope === s}
            onClick={() => setScope(s)}
            className={`px-3 py-1.5 rounded-md text-sm border ${scope === s
              ? 'bg-primary-600 text-white border-primary-600'
              : 'border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700'}`}
          >
            {t(`branding.pdfTheme.scope.${s}`, s)}
          </button>
        ))}
      </div>

      <fieldset className="mb-4">
        <legend className={labelClass}>{t('branding.pdfTheme.colors', 'Colours')}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {COLOR_KEYS.map((key) => {
            const own = draft.colors?.[key];
            const shown = own || resolved?.colors[key] || '#000000';
            const inputId = `pdf-theme-color-${key}`;
            return (
              <div key={key} className="flex items-center gap-2">
                <input
                  id={inputId}
                  type="color"
                  value={shown}
                  onChange={(e) => setColor(key, e.target.value)}
                  className="h-9 w-12 rounded border border-neutral-300 dark:border-neutral-600 bg-transparent"
                />
                <label htmlFor={inputId} className="flex-1 text-sm text-neutral-800 dark:text-neutral-200">
                  {t(`branding.pdfTheme.color.${key}`, key)}
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                    {own ? own : `${t('branding.pdfTheme.inherited', 'Inherited')} · ${shown}`}
                  </span>
                </label>
                {own && (
                  <button type="button" onClick={() => setColor(key, null)}
                    className="text-xs underline text-neutral-600 dark:text-neutral-300">
                    {t('branding.pdfTheme.reset', 'Reset')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div>
          <label htmlFor="pdf-theme-title-size" className={labelClass}>{t('branding.pdfTheme.titleSize', 'Title size')}</label>
          <select id="pdf-theme-title-size" className={fieldClass} value={draft.titleSize ?? ''}
            onChange={(e) => setField('titleSize', e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">{inherit(`${resolved?.titleSize ?? 20} pt`)}</option>
            {/* A stored size outside the usual steps (the API takes 12–32) stays selectable. */}
            {(draft.titleSize && !TITLE_SIZES.includes(draft.titleSize)
              ? [...TITLE_SIZES, draft.titleSize].sort((a, b) => a - b)
              : TITLE_SIZES
            ).map((size) => <option key={size} value={size}>{size} pt</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pdf-theme-font" className={labelClass}>{t('branding.pdfTheme.font', 'Font')}</label>
          <select id="pdf-theme-font" className={fieldClass} value={draft.fontFamily ?? ''}
            onChange={(e) => setField('fontFamily', e.target.value || undefined)}>
            <option value="">{inherit(resolved?.fontFamily ? familyLabel(resolved.fontFamily) : 'Helvetica')}</option>
            {(data?.fontFamilies || []).map((dir) => <option key={dir} value={dir}>{familyLabel(dir)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pdf-theme-page-numbers" className={labelClass}>{t('branding.pdfTheme.pageNumbers', 'Page numbers')}</label>
          <select id="pdf-theme-page-numbers" className={fieldClass} value={draft.pageNumbers ?? ''}
            onChange={(e) => setField('pageNumbers', (e.target.value || undefined) as PdfPageNumbers | undefined)}>
            <option value="">{inherit(t(`branding.pdfTheme.pageNumbersOption.${resolved?.pageNumbers ?? 'bottom-right'}`))}</option>
            {PAGE_NUMBERS.map((p) => <option key={p} value={p}>{t(`branding.pdfTheme.pageNumbersOption.${p}`, p)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pdf-theme-folding" className={labelClass}>{t('branding.pdfTheme.foldingMarks', 'Folding marks')}</label>
          <select id="pdf-theme-folding" className={fieldClass} value={draft.foldingMarks ?? ''}
            onChange={(e) => setField('foldingMarks', (e.target.value || undefined) as PdfFoldingMarks | undefined)}>
            <option value="">{inherit(t(`branding.pdfTheme.foldingOption.${resolved?.foldingMarks ?? 'none'}`))}</option>
            {FOLDING_MARKS.map((f) => <option key={f} value={f}>{t(`branding.pdfTheme.foldingOption.${f}`, f)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pdf-theme-footer" className={labelClass}>{t('branding.pdfTheme.footer', 'Footer')}</label>
          <select id="pdf-theme-footer" className={fieldClass} value={footerMode ?? ''}
            onChange={(e) => setField('footer', e.target.value
              ? { mode: e.target.value as PdfFooterMode, text: draft.footer?.text || '' }
              : undefined)}>
            <option value="">{inherit(t(`branding.pdfTheme.footerMode.${resolved?.footer.mode ?? 'address'}`))}</option>
            {FOOTER_MODES.map((m) => <option key={m} value={m}>{t(`branding.pdfTheme.footerMode.${m}`, m)}</option>)}
          </select>
        </div>
        {footerMode === 'custom' && (
          <div>
            <label htmlFor="pdf-theme-footer-text" className={labelClass}>{t('branding.pdfTheme.footerText', 'Footer text')}</label>
            <input id="pdf-theme-footer-text" className={fieldClass} maxLength={200} value={draft.footer?.text || ''}
              onChange={(e) => setField('footer', { mode: 'custom', text: e.target.value })} />
          </div>
        )}
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        {t('branding.pdfTheme.marginsNote', 'Margins follow the DIN 5008 letter layout and aren\'t adjustable.')}
      </p>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={preview} disabled={busy}>
          {t('branding.pdfTheme.preview', 'Preview PDF')}
        </Button>
        <PermissionGate permission="settings.banking">
          <Button variant="outline" onClick={() => { setDraft({}); void save({}); }}
            disabled={busy || !row || Object.keys(row.settings || {}).length === 0}>
            {t('branding.pdfTheme.resetScope', 'Reset to inherited')}
          </Button>
          <Button onClick={() => void save(draft)}
            disabled={busy || Object.values(draft.colors || {}).some((c) => !HEX.test(c))}>
            {t('branding.pdfTheme.save', 'Save theme')}
          </Button>
        </PermissionGate>
      </div>
    </Card>
  );
};
