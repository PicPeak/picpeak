/**
 * Settings → Brief templates (issue 2678).
 *
 * One field list for every occasion, then one per event type. A brief shows
 * the first, then its occasion's, each in the order set here. Every list is
 * a draft of its own, saved through the one save bar (each changed list in
 * its own request, a failed one stays unsaved). A saved field keeps its type:
 * briefs already hold values of that shape.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button, Card, ErrorState, Loading, Notice, Switch } from '../../components/common';
import { SettingsSaveBar } from '../../components/admin/SettingsSaveBar';
import { TEXT_LANGUAGES, TranslatableField } from '../../components/admin/TranslatableField';
import { usePermissions } from '../../contexts/PermissionsContext';
import { eventTypesService } from '../../services/eventTypes.service';
import {
  BRIEF_FIELD_TYPES, briefsService, type BriefFieldType, type BriefTemplateField, type BriefTemplates,
} from '../../services/briefs.service';

/** A row of the editor: the field plus a key that survives reordering. */
type Row = BriefTemplateField & { key: string };

const GLOBAL = 'global';
const strip = (rows: Row[]): BriefTemplateField[] => rows.map(({ key: _key, ...field }) => field);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let newKey = 0;

const savedList = (templates: BriefTemplates | undefined, occasion: string): BriefTemplateField[] =>
  (occasion === GLOBAL ? templates?.global : templates?.occasions[occasion]) || [];
const rowsOf = (fields: BriefTemplateField[]): Row[] => fields.map((f) => ({ ...f, key: `saved-${f.id}` }));

export const BriefTemplatesPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission('settings.edit');
  const templatesQuery = useQuery({ queryKey: ['brief-templates'], queryFn: () => briefsService.templates() });
  const { data: eventTypes = [] } = useQuery({ queryKey: ['event-types', 'all'], queryFn: () => eventTypesService.getEventTypes() });
  const templates = templatesQuery.data;

  const [occasion, setOccasion] = useState<string>(GLOBAL);
  // Drafts of the lists the admin touched; the others show what is saved.
  const [drafts, setDrafts] = useState<Record<string, Row[]>>({});
  const [saving, setSaving] = useState(false);

  if (templatesQuery.isLoading) return <Loading />;
  if (!templates) {
    return <ErrorState title={t('briefs.templates.loadFailed', 'Could not load the brief templates.')} onRetry={() => { void templatesQuery.refetch(); }} />;
  }

  const isDirty = (key: string) => !!drafts[key] && !same(strip(drafts[key]), savedList(templates, key));
  const dirtyKeys = Object.keys(drafts).filter(isDirty);
  const rows = drafts[occasion] ?? rowsOf(savedList(templates, occasion));
  const setRows = (next: Row[]) => setDrafts((d) => ({ ...d, [occasion]: next }));
  const update = (index: number, patch: Partial<Row>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const move = (index: number, by: number) => {
    const next = [...rows];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    setRows(next);
  };
  const occasionName = (key: string) => (key === GLOBAL
    ? t('briefs.templates.global', 'Every occasion')
    : eventTypes.find((e) => e.slug_prefix === key)?.name || key);

  const save = async () => {
    const missing = dirtyKeys.find((key) => drafts[key].some((r) => !r.label.trim()));
    if (missing) {
      setOccasion(missing);
      toast.error(t('briefs.templates.labelMissing', 'Every field needs a label.'));
      return;
    }
    setSaving(true);
    const failed: string[] = [];
    for (const key of dirtyKeys) {
      try {
        const fields = await briefsService.saveTemplate(key === GLOBAL ? null : key, strip(drafts[key]));
        qc.setQueryData<BriefTemplates>(['brief-templates'], (old) => (old && (key === GLOBAL
          ? { ...old, global: fields }
          : { ...old, occasions: { ...old.occasions, [key]: fields } })));
        setDrafts((d) => {
          const { [key]: _saved, ...rest } = d;
          return rest;
        });
      } catch (err) {
        failed.push(occasionName(key));
        const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        if (message) toast.error(message);
      }
    }
    setSaving(false);
    if (failed.length) toast.error(t('briefs.templates.saveFailed', 'Not saved: {{lists}}', { lists: failed.join(', ') }));
    else toast.success(t('briefs.templates.saved', 'Brief templates saved'));
  };

  return (
    <div className="space-y-6">
      {!canEdit && <Notice tone="info">{t('briefs.templates.readOnly', 'You can see these templates but not change them.')}</Notice>}
      <Card>
        <label htmlFor="brief-template-occasion" className="block text-sm font-medium text-body mb-1">
          {t('briefs.templates.occasion', 'Template')}
        </label>
        <select id="brief-template-occasion" value={occasion} onChange={(e) => setOccasion(e.target.value)} className="input w-full sm:w-80">
          {[GLOBAL, ...eventTypes.map((e) => e.slug_prefix)].map((key) => (
            <option key={key} value={key}>{occasionName(key)}{isDirty(key) ? ` • ${t('briefs.notSaved', 'not saved yet')}` : ''}</option>
          ))}
        </select>
        <p className="text-xs text-muted mt-1">
          {occasion === GLOBAL
            ? t('briefs.templates.globalHint', 'These fields appear on every brief, before the fields of its occasion.')
            : t('briefs.templates.occasionHint', 'These fields follow the fields for every occasion on a {{occasion}} brief.', { occasion: occasionName(occasion) })}
        </p>
      </Card>

      {/* Closed while saving: the save replaces each saved list's draft. */}
      <fieldset disabled={!canEdit || saving} className="space-y-3">
        {rows.length === 0 && (
          <Card><p className="text-sm text-muted">{t('briefs.templates.empty', 'No fields yet.')}</p></Card>
        )}
        {rows.map((row, index) => (
          <Card key={row.key}>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_14rem] gap-4">
              <TranslatableField
                id={`brief-template-label-${row.key}`}
                label={t('briefs.templates.label', 'Label')}
                labelClassName="block text-sm font-medium text-body mb-1"
                primary={null}
                languages={TEXT_LANGUAGES}
                value={row.label}
                onChange={(label) => update(index, { label })}
                translations={row.labels}
                onTranslationChange={(language, text) => update(index, { labels: { ...row.labels, [language]: text } })}
                maxLength={120}
                inputClassName="input w-full"
              />
              <div>
                <label htmlFor={`brief-template-type-${row.key}`} className="block text-sm font-medium text-body mb-1">{t('briefs.templates.type', 'Type')}</label>
                <select
                  id={`brief-template-type-${row.key}`}
                  value={row.type}
                  disabled={row.id != null}
                  onChange={(e) => update(index, { type: e.target.value as BriefFieldType })}
                  className="input w-full"
                >
                  {BRIEF_FIELD_TYPES.map((type) => <option key={type} value={type}>{t(`briefs.types.${type}`)}</option>)}
                </select>
                {row.id != null && <p className="text-xs text-muted mt-1">{t('briefs.templates.typeFixed', 'Saved fields keep their type.')}</p>}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <Switch
                checked={row.visibleDefault}
                onChange={(visibleDefault) => update(index, { visibleDefault })}
                label={t('briefs.templates.visibleDefault', 'The customer sees it')}
                size="sm"
              />
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => move(index, -1)} disabled={index === 0} aria-label={t('briefs.templates.moveUp', 'Move up') as string}>
                  <ArrowUp className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => move(index, 1)} disabled={index === rows.length - 1} aria-label={t('briefs.templates.moveDown', 'Move down') as string}>
                  <ArrowDown className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, i) => i !== index))} aria-label={t('briefs.templates.remove', 'Remove field') as string}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
        <Button
          variant="outline"
          size="sm"
          leftIcon={<Plus className="w-4 h-4" />}
          onClick={() => setRows([...rows, { key: `new-${newKey += 1}`, label: '', labels: {}, type: 'short_text', visibleDefault: true }])}
        >
          {t('briefs.templates.add', 'Add field')}
        </Button>
        <p className="text-xs text-muted">
          {t('briefs.templates.removeHint', 'Removing a field keeps what briefs already hold: it stays readable there, marked as no longer in the template, and the customer no longer sees it.')}
        </p>
      </fieldset>

      {canEdit && (
        <SettingsSaveBar isDirty={dirtyKeys.length > 0} isSaving={saving} onSave={() => { void save(); }} onDiscard={() => setDrafts({})} />
      )}
    </div>
  );
};
