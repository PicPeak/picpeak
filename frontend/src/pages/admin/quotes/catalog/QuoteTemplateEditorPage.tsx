/**
 * Quote template editor (#1451). Edits the template's working copy —
 * sections, texts, pre-ticked promotions and defaults — and publishes it as
 * an immutable version. Quotes are created from the latest version (or a
 * pinned one), so editing here never changes a quote that already exists.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input, Loading } from '../../../../components/common';
import { DecimalInput } from '../../../../components/common/DecimalInput';
import { VatRateSelect } from '../../../../components/admin/VatRateSelect';
import { PermissionGate } from '../../../../components/admin/PermissionGate';
import { quotesService } from '../../../../services/quotes.service';
import {
  quoteCatalogService,
  type TemplateDraft, type TemplateLine, type TemplateSection,
} from '../../../../services/quoteCatalog.service';
import { eventTypesService } from '../../../../services/eventTypes.service';
import { workflowsService } from '../../../../services/workflows.service';
import { useFeatureFlags } from '../../../../contexts/FeatureFlagsContext';
import { contractTemplatesService } from '../../../../services/contractTemplates.service';
import { usePermissions } from '../../../../contexts/PermissionsContext';
import { useLocalizedDate } from '../../../../hooks/useLocalizedDate';
import type { BoundTo, LineUnit } from '../../../../utils/lineItemTotals';

const UNITS: LineUnit[] = ['hour', 'day', 'piece', 'km', 'flat'];
const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'];
const LANGUAGES = ['de', 'en', 'fr', 'nl', 'pt', 'ru'];
const inputCls = 'w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900';
// Native selects ignore vertical padding in Safari; a fixed height keeps them level with the inputs.
const selectCls = `${inputCls} h-10`;
const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
// The API's message, plus what each rejected field says (a 400 lists them in `details`).
const errorText = (err: any): string => {
  const data = err?.response?.data;
  const details: Array<{ field?: string; message?: string }> = Array.isArray(data?.details) ? data.details : [];
  const reasons = details
    .map((d) => (d.message && d.message !== 'Invalid value' ? d.message : d.field ? `${d.field}: ${d.message || 'invalid'}` : null))
    .filter(Boolean);
  if (reasons.length) return reasons.join(' · ');
  return data?.error || err?.message || 'Failed';
};

const newLine = (): TemplateLine => ({
  description: '', quantity: 1, unitPriceMinor: 0, discountPercent: 0, unit: null, priceMode: null,
  boundTo: null, rateSource: null, detailsText: null,
});

interface Meta {
  name: string;
  description: string;
  eventType: string;
  language: string;
  currency: string;
  /** '' = the default contract template. */
  contractTemplateId: string;
}

/** Editor for one free line (and, for the top level, its sub-items). */
const LineFields: React.FC<{ line: TemplateLine; onChange: (line: TemplateLine) => void; idPrefix: string }> = ({ line, onChange, idPrefix }) => {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
      <textarea aria-label={t('crm.lineItems.description', 'Description') as string} rows={1}
        className={`${inputCls} md:col-span-3`} value={line.description}
        placeholder={t('crm.lineItems.descriptionPlaceholder', 'Description (multi-line OK)') as string}
        onChange={(e) => onChange({ ...line, description: e.target.value })} />
      <DecimalInput id={`${idPrefix}-qty`} aria-label={t('crm.lineItems.quantity', 'Qty') as string} className={inputCls}
        value={line.quantity} onChange={(n) => onChange({ ...line, quantity: Number.isFinite(n) ? n : 1 })} />
      <DecimalInput id={`${idPrefix}-price`} aria-label={t('crm.lineItems.unitPrice', 'Unit') as string} className={inputCls}
        value={line.unitPriceMinor / 100} fractionDigits={2}
        onChange={(n) => onChange({ ...line, unitPriceMinor: Math.round((Number.isFinite(n) ? n : 0) * 100) })} />
      <select aria-label={t('crm.lineItems.unitLabel', 'Unit') as string} className={selectCls} value={line.unit || ''}
        onChange={(e) => onChange({ ...line, unit: (e.target.value || null) as LineUnit | null })}>
        <option value="">{t('crm.lineItems.unitNone', '—')}</option>
        {UNITS.map((u) => <option key={u} value={u}>{t(`crm.lineItems.unitOption.${u}`, u)}</option>)}
      </select>
    </div>
  );
};

export const QuoteTemplateEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const templateId = parseInt(id || '0', 10);
  const { flags } = useFeatureFlags();
  const { hasPermission, isSuperAdmin } = usePermissions();
  // GET /admin/workflows checks workflows.view: without it the query is a
  // guaranteed 403 and the picker would render empty with no explanation.
  const canSeeWorkflows = !!flags.workflows && (isSuperAdmin || hasPermission('workflows.view'));
  const { formatDateTime } = useLocalizedDate();

  const { data, isLoading } = useQuery({
    queryKey: ['quote-template', templateId],
    queryFn: () => quoteCatalogService.getTemplate(templateId),
    enabled: templateId > 0,
  });
  const { data: presetData } = useQuery({ queryKey: ['line-item-presets'], queryFn: () => quotesService.listLineItemPresets() });
  const { data: packages = [] } = useQuery({
    queryKey: ['quote-catalog', 'packages', 'active'],
    queryFn: () => quoteCatalogService.listPackages({ activeOnly: true }),
  });
  const { data: promotions = [] } = useQuery({
    queryKey: ['quote-catalog', 'promotions', 'active'],
    queryFn: () => quoteCatalogService.listPromotions({ activeOnly: true }),
  });
  const { data: textBlocks = [] } = useQuery({
    queryKey: ['quote-catalog', 'text-blocks', 'active'],
    queryFn: () => quoteCatalogService.listTextBlocks({ activeOnly: true }),
  });
  const { data: eventTypes = [] } = useQuery({ queryKey: ['event-types-active'], queryFn: () => eventTypesService.getActiveEventTypes() });
  const { data: netDays } = useQuery({ queryKey: ['payment-net-days-templates'], queryFn: () => quotesService.listPaymentNetDaysTemplates() });
  const { data: timing } = useQuery({ queryKey: ['payment-timing-templates'], queryFn: () => quotesService.listPaymentTimingTemplates() });
  const { data: workflows = [] } = useQuery({ queryKey: ['workflows'], queryFn: () => workflowsService.list(), enabled: canSeeWorkflows });
  const bookingWorkflows = useMemo(() => workflows.filter((w) => w.trigger_type === 'quote.accepted'), [workflows]);
  const presets = presetData?.presets || [];

  const [meta, setMeta] = useState<Meta>({ name: '', description: '', eventType: '', language: 'de', currency: 'CHF', contractTemplateId: '' });
  // The contract templates a quote made from this template can become (#1445).
  const { data: contractTemplates } = useQuery({
    queryKey: ['contract-templates'],
    queryFn: () => contractTemplatesService.list(),
    enabled: !!flags.contracts,
    retry: false,
  });
  const usableContractTemplates = (contractTemplates?.templates || []).filter((ct) => ct.status !== 'archived' && ct.currentVersionId);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const tpl = data.template;
    setMeta({
      name: tpl.name,
      description: tpl.description || '',
      eventType: tpl.eventType || '',
      language: tpl.language || 'de',
      currency: tpl.currency || 'CHF',
      contractTemplateId: tpl.defaultContractTemplateId ? String(tpl.defaultContractTemplateId) : '',
    });
    setDraft(tpl.draft);
  }, [data]);

  if (isLoading || !data || !draft) return <Loading />;
  const template = data.template;
  const archived = template.status === 'archived';

  const setSections = (sections: TemplateSection[]) => setDraft({ ...draft, sections });
  const updateSection = (idx: number, section: TemplateSection) => setSections(draft.sections.map((s, i) => (i === idx ? section : s)));
  const moveSection = (idx: number, dir: -1 | 1) => {
    const other = idx + dir;
    if (other < 0 || other >= draft.sections.length) return;
    const next = [...draft.sections];
    [next[idx], next[other]] = [next[other], next[idx]];
    setSections(next);
  };

  const save = async (quiet = false) => {
    setBusy(true);
    try {
      await quoteCatalogService.updateTemplate(templateId, {
        name: meta.name.trim() || template.name,
        description: meta.description || null,
        eventType: meta.eventType || null,
        language: meta.language || null,
        currency: meta.currency || null,
        ...(contractTemplates ? { defaultContractTemplateId: meta.contractTemplateId ? Number(meta.contractTemplateId) : null } : {}),
        draft,
      });
      await qc.invalidateQueries({ queryKey: ['quote-template', templateId] });
      qc.invalidateQueries({ queryKey: ['quote-catalog', 'templates'] });
      if (!quiet) toast.success(t('quotes.templates.savedToast', 'Template saved.'));
      return true;
    } catch (err) {
      toast.error(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!(await save(true))) return;
    setBusy(true);
    try {
      const result = await quoteCatalogService.publishTemplate(templateId);
      await qc.invalidateQueries({ queryKey: ['quote-template', templateId] });
      qc.invalidateQueries({ queryKey: ['quote-catalog', 'templates'] });
      toast.success(t('quotes.templates.publishedToast', 'Published as version {{version}}.', { version: result.version }));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!window.confirm(t('quotes.templates.archiveConfirm', 'Archive this template? Existing quotes are not affected.'))) return;
    try {
      await quoteCatalogService.archiveTemplate(templateId);
      qc.invalidateQueries({ queryKey: ['quote-catalog', 'templates'] });
      navigate('/admin/clients/quotes/catalog?tab=templates');
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const togglePromotion = (promotionId: number, on: boolean) => setDraft({
    ...draft,
    promotionIds: on ? [...draft.promotionIds, promotionId] : draft.promotionIds.filter((pid) => pid !== promotionId),
  });

  const statusLabel = ({
    draft: t('quotes.templates.status.draft', 'Draft'),
    published: t('quotes.templates.status.published', 'Published'),
    archived: t('quotes.templates.status.archived', 'Archived'),
  } as Record<string, string>)[template.status];

  const sectionTitle = (s: TemplateSection) => ({
    item: t('quotes.templates.section.item', 'Catalogue item'),
    package: t('quotes.templates.section.package', 'Package'),
    line: t('quotes.templates.section.line', 'Own line'),
  })[s.type];

  const textSource = (blockId: number | null, text: string | null) => (blockId ? 'block' : text != null ? 'text' : 'none');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <button onClick={() => navigate('/admin/clients/quotes/catalog?tab=templates')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
            {template.name}
            <span className="ml-2 text-sm font-normal text-neutral-500 dark:text-neutral-400">
              {statusLabel}{template.currentVersion != null && ` · v${template.currentVersion}`}
            </span>
          </h2>
        </div>
        {/* Writes need quotes.manage; with quotes.view the editor is read-only. */}
        {!archived && (
          <PermissionGate permission="quotes.manage">
            <div className="flex gap-2">
              <Button variant="outline" onClick={archive} disabled={busy}>{t('quotes.catalog.archive', 'Archive')}</Button>
              <Button variant="outline" onClick={() => save()} disabled={busy}>{t('quotes.templates.saveDraft', 'Save draft')}</Button>
              <Button onClick={publish} disabled={busy || draft.sections.length === 0}>{t('quotes.templates.publish', 'Publish')}</Button>
            </div>
          </PermissionGate>
        )}
      </div>

      <Card padding="lg">
        <h3 className="font-semibold mb-3">{t('quotes.templates.details', 'Details')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('quotes.catalog.field.name', 'Name') as string} value={meta.name}
            onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          <div>
            <label htmlFor="template-event-type" className={labelCls}>{t('quotes.field.eventType', 'Event type')}</label>
            <select id="template-event-type" className={selectCls} value={meta.eventType}
              onChange={(e) => setMeta({ ...meta, eventType: e.target.value })}>
              <option value="">{t('quotes.field.eventTypeNone', '— Use default —')}</option>
              {eventTypes.map((et) => <option key={et.id} value={et.slug_prefix}>{et.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="template-language" className={labelCls}>{t('quotes.catalog.field.language', 'Language')}</label>
            <select id="template-language" className={selectCls} value={meta.language}
              onChange={(e) => setMeta({ ...meta, language: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="template-currency" className={labelCls}>{t('quotes.field.currency', 'Currency')}</label>
            <select id="template-currency" className={selectCls} value={meta.currency}
              onChange={(e) => setMeta({ ...meta, currency: e.target.value })}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          {contractTemplates && (
            <div>
              <label htmlFor="template-contract-template" className={labelCls}>
                {t('quotes.templates.contractTemplate', 'Contract template')}
              </label>
              <select id="template-contract-template" className={selectCls} value={meta.contractTemplateId}
                onChange={(e) => setMeta({ ...meta, contractTemplateId: e.target.value })}>
                <option value="">{t('quotes.templates.contractTemplateDefault', '— The default contract template —')}</option>
                {usableContractTemplates.map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
              </select>
            </div>
          )}
          <div className="md:col-span-2">
            <label htmlFor="template-description" className={labelCls}>{t('quotes.catalog.field.description', 'Description')}</label>
            <textarea id="template-description" rows={2} className={inputCls} value={meta.description}
              onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
          </div>
        </div>
      </Card>

      <Card padding="lg">
        <h3 className="font-semibold mb-3">{t('quotes.templates.sections', 'Lines')}</h3>
        <div className="space-y-3">
          {draft.sections.map((section, idx) => (
            <div key={idx} className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{sectionTitle(section)}</span>
                <div className="flex items-center gap-1">
                  <label className="mr-2 inline-flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                    <input type="checkbox" checked={section.isOptional}
                      onChange={(e) => updateSection(idx, { ...section, isOptional: e.target.checked })} />
                    {t('crm.lineItems.optional', 'Offer as add-on')}
                  </label>
                  <button type="button" onClick={() => moveSection(idx, -1)} aria-label="Move up" className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"><ArrowUp className="w-4 h-4" /></button>
                  <button type="button" onClick={() => moveSection(idx, 1)} aria-label="Move down" className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"><ArrowDown className="w-4 h-4" /></button>
                  <button type="button" onClick={() => setSections(draft.sections.filter((_, i) => i !== idx))} aria-label="Remove"
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"><X className="w-4 h-4" /></button>
                </div>
              </div>

              {section.type === 'item' && (() => {
                const preset = presets.find((p) => p.id === section.presetId);
                const rateBased = preset?.priceMode === 'hour' || preset?.priceMode === 'day';
                return (
                  <div className="flex flex-wrap gap-2">
                    <select aria-label={t('quotes.templates.section.item', 'Catalogue item') as string} className={`${selectCls} flex-1 min-w-[12rem]`}
                      value={section.presetId}
                      onChange={(e) => updateSection(idx, { ...section, presetId: Number(e.target.value), boundTo: null })}>
                      {!preset && <option value={section.presetId}>#{section.presetId}</option>}
                      {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <DecimalInput aria-label={t('crm.lineItems.quantity', 'Qty') as string} className={`${inputCls} w-24`}
                      value={section.quantity ?? NaN} placeholder={preset ? String(preset.quantityDefault) : ''}
                      onChange={(n) => updateSection(idx, { ...section, quantity: Number.isFinite(n) ? n : null })} />
                    {rateBased && (
                      <select aria-label={t('quotes.catalog.boundTo', 'Quantity') as string} className={`${selectCls} w-auto`} value={section.boundTo || ''}
                        onChange={(e) => updateSection(idx, { ...section, boundTo: (e.target.value || null) as BoundTo | null })}>
                        <option value="">{t('quotes.catalog.boundToNone', 'Fixed quantity')}</option>
                        <option value="hours">{t('crm.lineItems.followsHours', 'Follows the quote hours')}</option>
                        <option value="days">{t('crm.lineItems.followsDays', 'Follows the quote days')}</option>
                      </select>
                    )}
                  </div>
                );
              })()}

              {section.type === 'package' && (
                <select aria-label={t('quotes.templates.section.package', 'Package') as string} className={selectCls} value={section.packageId}
                  onChange={(e) => updateSection(idx, { ...section, packageId: Number(e.target.value) })}>
                  {!packages.some((p) => p.id === section.packageId) && <option value={section.packageId}>#{section.packageId}</option>}
                  {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}

              {section.type === 'line' && (
                <div className="space-y-2">
                  <LineFields idPrefix={`section-${idx}`} line={section.line}
                    onChange={(line) => updateSection(idx, { ...section, line })} />
                  {section.children.map((child, cIdx) => (
                    <div key={cIdx} className="flex items-start gap-2 pl-6">
                      <div className="flex-1">
                        <LineFields idPrefix={`section-${idx}-child-${cIdx}`} line={child}
                          onChange={(line) => updateSection(idx, { ...section, children: section.children.map((c, i) => (i === cIdx ? line : c)) })} />
                      </div>
                      <button type="button" aria-label="Remove"
                        onClick={() => updateSection(idx, { ...section, children: section.children.filter((_, i) => i !== cIdx) })}
                        className="p-1 mt-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm"
                    onClick={() => updateSection(idx, { ...section, children: [...section.children, newLine()] })}>
                    <Plus className="w-4 h-4 mr-1" />{t('crm.lineItems.addSubItem', 'Add sub-item')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {presets.length > 0 && (
            <Button variant="outline" size="sm"
              onClick={() => setSections([...draft.sections, { type: 'item', presetId: presets[0].id, quantity: null, boundTo: null, isOptional: false }])}>
              <Plus className="w-4 h-4 mr-1" />{t('quotes.templates.addItem', 'Catalogue item')}
            </Button>
          )}
          {packages.length > 0 && (
            <Button variant="outline" size="sm"
              onClick={() => setSections([...draft.sections, { type: 'package', packageId: packages[0].id, isOptional: false }])}>
              <Plus className="w-4 h-4 mr-1" />{t('quotes.templates.addPackage', 'Package')}
            </Button>
          )}
          <Button variant="outline" size="sm"
            onClick={() => setSections([...draft.sections, { type: 'line', line: newLine(), children: [], isOptional: false }])}>
            <Plus className="w-4 h-4 mr-1" />{t('quotes.templates.addLine', 'Own line')}
          </Button>
        </div>
      </Card>

      <Card padding="lg">
        <h3 className="font-semibold mb-3">{t('quotes.templates.texts', 'Intro and outro')}</h3>
        {(['intro', 'outro'] as const).map((which) => {
          const blockKey = which === 'intro' ? 'introTextBlockId' : 'outroTextBlockId';
          const textKey = which === 'intro' ? 'introText' : 'outroText';
          const source = textSource(draft[blockKey], draft[textKey]);
          return (
            <div key={which} className="mb-4">
              <label htmlFor={`template-${which}-source`} className={labelCls}>
                {which === 'intro' ? t('quotes.field.introText', 'Intro text') : t('quotes.field.outroText', 'Outro text')}
              </label>
              <select id={`template-${which}-source`} className={`${selectCls} mb-2`} value={source}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === 'block') setDraft({ ...draft, [blockKey]: textBlocks[0]?.id ?? null, [textKey]: null });
                  else if (next === 'text') setDraft({ ...draft, [blockKey]: null, [textKey]: draft[textKey] ?? '' });
                  else setDraft({ ...draft, [blockKey]: null, [textKey]: null });
                }}>
                <option value="none">{t('quotes.templates.textNone', 'None')}</option>
                {textBlocks.length > 0 && <option value="block">{t('quotes.templates.textFromBlock', 'Text block')}</option>}
                <option value="text">{t('quotes.templates.textOwn', 'Own text')}</option>
              </select>
              {source === 'block' && (
                <select aria-label={t('quotes.textBlocks.insert', 'Insert text block…') as string} className={selectCls}
                  value={draft[blockKey] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [blockKey]: Number(e.target.value) })}>
                  {textBlocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              )}
              {source === 'text' && (
                <textarea aria-label={which} rows={3} className={inputCls} value={draft[textKey] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [textKey]: e.target.value })} />
              )}
            </div>
          );
        })}
      </Card>

      {promotions.length > 0 && (
        <Card padding="lg">
          <h3 className="font-semibold mb-3">{t('quotes.templates.promotions', 'Pre-ticked discounts')}</h3>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {promotions.map((p) => (
              <label key={p.id} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.promotionIds.includes(p.id)}
                  onChange={(e) => togglePromotion(p.id, e.target.checked)} />
                {p.name}
              </label>
            ))}
          </div>
        </Card>
      )}

      <Card padding="lg">
        <h3 className="font-semibold mb-3">{t('quotes.templates.defaults', 'Defaults for new quotes')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label htmlFor="template-hours" className={labelCls}>{t('quotes.field.hours', 'Hours')}</label>
            <DecimalInput id="template-hours" className={inputCls} value={draft.hours ?? NaN} fractionDigits={2}
              onChange={(n) => setDraft({ ...draft, hours: Number.isFinite(n) ? n : null })} />
          </div>
          <div>
            <label htmlFor="template-days" className={labelCls}>{t('quotes.field.days', 'Days')}</label>
            <DecimalInput id="template-days" className={inputCls} value={draft.days ?? NaN} fractionDigits={2}
              onChange={(n) => setDraft({ ...draft, days: Number.isFinite(n) ? n : null })} />
          </div>
          <div>
            <label htmlFor="template-validity" className={labelCls}>{t('quotes.templates.validityDays', 'Valid for (days)')}</label>
            <DecimalInput id="template-validity" className={inputCls} value={draft.validityDays ?? NaN}
              onChange={(n) => setDraft({ ...draft, validityDays: Number.isFinite(n) ? Math.round(n) : null })} />
          </div>
          <div>
            <label htmlFor="template-net-days" className={labelCls}>{t('quotes.field.paymentNetDays', 'Net days')}</label>
            <select id="template-net-days" className={selectCls} value={draft.paymentNetDaysTemplateId ?? ''}
              onChange={(e) => setDraft({ ...draft, paymentNetDaysTemplateId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('quotes.field.selectNetDays', '— Select net days —')}</option>
              {netDays?.templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="template-timing" className={labelCls}>{t('quotes.field.paymentTiming', 'Payment schedule')}</label>
            <select id="template-timing" className={selectCls} value={draft.paymentTimingTemplateId ?? ''}
              onChange={(e) => setDraft({ ...draft, paymentTimingTemplateId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('quotes.field.selectTiming', '— Select schedule —')}</option>
              {timing?.templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
          </div>
          {canSeeWorkflows && (
            <div>
              <label htmlFor="template-workflow" className={labelCls}>{t('quotes.field.bookingWorkflow', 'Booking workflow (on acceptance)')}</label>
              <select id="template-workflow" className={selectCls} value={draft.bookingWorkflowId ?? ''}
                onChange={(e) => setDraft({ ...draft, bookingWorkflowId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t('quotes.field.bookingWorkflowNone', '— None —')}</option>
                {bookingWorkflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <VatRateSelect label={t('quotes.field.vatRate', 'VAT rate %') as string}
              rate={draft.vatRate ?? 0} code={draft.vatCode}
              onChange={(rate, code) => setDraft({ ...draft, vatRate: rate, vatCode: code })} />
          </div>
        </div>
      </Card>

      {data.versions.length > 0 && (
        <Card padding="lg">
          <h3 className="font-semibold mb-3">{t('quotes.templates.versions', 'Published versions')}</h3>
          <ul className="text-sm space-y-1 text-neutral-700 dark:text-neutral-300">
            {data.versions.map((v) => (
              <li key={v.id}>v{v.version} — {formatDateTime(v.publishedAt)}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
};
