/**
 * Admin → Contracts → Templates → one template (#1445).
 *
 * The working copy is the template's draft (made from the published version
 * on the first save). Clauses are clause-library blocks — optionally with
 * this template's own text per language — or free-text sections, in the
 * order shown. Saving sends the lockVersion that was loaded, so another
 * admin's save is reported instead of overwritten. Publishing freezes a
 * version; earlier versions stay in the history and can start a new draft.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input, Loading } from '../../../components/common';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { AttachmentListEditor, type AttachmentRow } from '../../../components/admin/AttachmentListEditor';
import type { IncludedAttachment } from '../../../services/documentAttachments.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import {
  contractsService, CONTRACT_SECTIONS, type ContractBlock, type ContractBlockSection,
} from '../../../services/contracts.service';
import {
  contractTemplatesService, templateError, CONTRACT_LOCALES, CONTRACT_PLACEHOLDERS,
  type ContractLocale, type ContractTemplateDetail, type LocaleText,
} from '../../../services/contractTemplates.service';

interface DraftItem {
  key: string;
  kind: 'block' | 'text';
  blockId: number | null;
  section: ContractBlockSection;
  name: string;
  heading: string;
  /** A block's text in this template, or a free-text section's body. */
  body: LocaleText;
  /** The text a block override starts from (frozen or library). */
  baseText: LocaleText;
  blockArchived: boolean;
  expanded: boolean;
}

const toAttachmentRows = (list?: IncludedAttachment[]): AttachmentRow[] => (list || []).map((a) => ({ attachmentId: a.attachmentId, delivery: a.delivery, name: a.name, pages: a.pages, bytes: a.bytes, isActive: a.isActive }));

let keyCounter = 0;
const nextKey = () => {
  keyCounter += 1;
  return `clause-${keyCounter}`;
};

const fieldClass = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 '
  + 'bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100';
const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const iconButton = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 p-1 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 '
  + 'disabled:opacity-40 hover:bg-neutral-50 dark:hover:bg-neutral-700';

function libraryBodies(block: ContractBlock): LocaleText {
  const out: LocaleText = {};
  const pairs: Array<[ContractLocale, string | null]> = [
    ['en', block.bodyText], ['de', block.bodyTextDe], ['ru', block.bodyTextRu],
    ['pt', block.bodyTextPt], ['nl', block.bodyTextNl], ['fr', block.bodyTextFr],
  ];
  for (const [locale, text] of pairs) if (text && text.trim()) out[locale] = text;
  return out;
}

function toDraftItems(detail: ContractTemplateDetail): DraftItem[] {
  const source = detail.draft || detail.published;
  return (source?.items || []).map((item) => ({
    key: nextKey(),
    kind: item.kind,
    blockId: item.blockId,
    section: item.section,
    name: item.block?.name || '',
    heading: item.heading || '',
    body: item.body || {},
    baseText: item.kind === 'block'
      ? (item.snapshot && Object.keys(item.snapshot).length ? item.snapshot : item.block?.bodies || {})
      : {},
    blockArchived: item.kind === 'block' && item.block ? !item.block.isActive : false,
    expanded: false,
  }));
}

/** A text per language, with a tab per language. */
const LocaleTextField: React.FC<{
  id: string;
  label: string;
  value: LocaleText;
  onChange: (value: LocaleText) => void;
  hint?: LocaleText;
  rows?: number;
  readOnly?: boolean;
}> = ({ id, label, value, onChange, hint, rows = 3, readOnly = false }) => {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<ContractLocale>('de');
  return (
    <div>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <label htmlFor={`${id}-${locale}`} className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</label>
        <div className="flex gap-1" role="group" aria-label={t('contracts.templates.languages', 'Languages') as string}>
          {CONTRACT_LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={locale === l}
              onClick={() => setLocale(l)}
              className={`px-2 py-0.5 rounded text-xs border ${locale === l
                ? 'bg-primary-600 text-white border-primary-600'
                : 'border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300'}`}
            >
              {l.toUpperCase()}{value[l] ? ' •' : ''}
            </button>
          ))}
        </div>
      </div>
      <textarea
        id={`${id}-${locale}`}
        rows={rows}
        className={fieldClass}
        value={value[locale] || ''}
        readOnly={readOnly}
        placeholder={hint?.[locale] || hint?.en || hint?.de || ''}
        onChange={(e) => onChange({ ...value, [locale]: e.target.value })}
      />
    </div>
  );
};

export const ContractTemplateEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const templateId = Number(id);
  const queryKey = useMemo(() => ['contract-template', templateId], [templateId]);
  const queryClient = useQueryClient();
  const { formatDateTime } = useLocalizedDate();

  const { data: detail, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => contractTemplatesService.get(templateId),
    enabled: Number.isFinite(templateId),
  });
  const { data: library } = useQuery({
    queryKey: ['contracts', 'blocks-library'],
    queryFn: () => contractsService.listBlocks({ includeInactive: false }),
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [useCase, setUseCase] = useState('');
  const [title, setTitle] = useState('');
  const [intro, setIntro] = useState<LocaleText>({});
  const [outro, setOutro] = useState<LocaleText>({});
  const [items, setItems] = useState<DraftItem[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [lockVersion, setLockVersion] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickBlockId, setPickBlockId] = useState('');

  // Load the draft (or the published version) whenever the server copy changes.
  useEffect(() => {
    if (!detail) return;
    const source = detail.draft || detail.published;
    setName(detail.template.name);
    setDescription(detail.template.description || '');
    setUseCase(detail.template.useCase || '');
    setTitle(source?.title || '');
    setIntro(source?.introText || {});
    setOutro(source?.outroText || {});
    setItems(toDraftItems(detail));
    setAttachments(toAttachmentRows(source?.attachments));
    setLockVersion(detail.template.lockVersion);
  }, [detail]);

  const readOnly = !detail || detail.template.isSystem || detail.template.status === 'archived';
  const blocksBySection = useMemo(() => {
    const out = new Map<ContractBlockSection, ContractBlock[]>();
    for (const block of library?.blocks || []) {
      out.set(block.section, [...(out.get(block.section) || []), block]);
    }
    return out;
  }, [library]);

  const store = (next: ContractTemplateDetail) => {
    queryClient.setQueryData(queryKey, next);
    void queryClient.invalidateQueries({ queryKey: ['contract-templates'] });
  };

  const fail = (err: unknown, fallback: string) => {
    const { message, code } = templateError(err);
    if (code === 'TEMPLATE_CONFLICT') setConflict(true);
    else setProblem(message || fallback);
  };

  const saveDraft = async (): Promise<ContractTemplateDetail | null> => {
    setProblem(null);
    try {
      const saved = await contractTemplatesService.saveDraft(templateId, {
        lockVersion,
        name: name.trim(),
        description: description.trim() || null,
        useCase: useCase.trim() || null,
        title: title.trim() || null,
        introText: intro,
        outroText: outro,
        items: items.map((item) => (item.kind === 'block'
          ? { kind: 'block', blockId: item.blockId, body: item.body }
          : { kind: 'text', section: item.section, heading: item.heading.trim() || null, body: item.body })),
        attachments: attachments.map((a) => ({ attachmentId: a.attachmentId, delivery: a.delivery })),
      });
      store(saved);
      return saved;
    } catch (err) {
      fail(err, t('contracts.templates.saveFailed', 'The draft could not be saved.') as string);
      return null;
    }
  };

  const onSave = async () => {
    setBusy(true);
    const saved = await saveDraft();
    setBusy(false);
    if (saved) toast.success(t('contracts.templates.saved', 'Draft saved'));
  };

  const onPublish = async () => {
    setBusy(true);
    try {
      const saved = await saveDraft();
      if (!saved) return;
      const published = await contractTemplatesService.publish(templateId, saved.template.lockVersion);
      store(published);
      toast.success(t('contracts.templates.published', 'Version {{version}} published', { version: published.version }));
    } catch (err) {
      fail(err, t('contracts.templates.publishFailed', 'The template could not be published.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onPreview = async (version?: number) => {
    setBusy(true);
    try {
      if (!version && !readOnly && !(await saveDraft())) return;
      const url = await contractTemplatesService.previewUrl(templateId, version);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      fail(err, t('contracts.templates.previewFailed', 'The preview could not be rendered.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onDraftFromVersion = async (version: number) => {
    if (!window.confirm(t('contracts.templates.draftFromVersionConfirm',
      'Replace the current draft with a copy of version {{version}}?', { version }) as string)) return;
    setBusy(true);
    try {
      store(await contractTemplatesService.draftFromVersion(templateId, version, lockVersion));
      toast.success(t('contracts.templates.draftCreated', 'Draft created from version {{version}}', { version }));
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onDuplicate = async () => {
    setBusy(true);
    try {
      const copy = await contractTemplatesService.duplicate(templateId,
        t('contracts.templates.copyName', '{{name}} (copy)', { name }) as string);
      void queryClient.invalidateQueries({ queryKey: ['contract-templates'] });
      navigate(`/admin/clients/contracts/templates/${copy.template.id}`);
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: -1 | 1) => setItems((cur) => {
    const target = index + delta;
    if (target < 0 || target >= cur.length) return cur;
    const next = [...cur];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const update = (key: string, patch: Partial<DraftItem>) => setItems((cur) => cur.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  const remove = (key: string) => setItems((cur) => cur.filter((it) => it.key !== key));
  const addBlock = () => {
    const block = library?.blocks.find((b) => b.id === Number(pickBlockId));
    if (!block) return;
    setItems((cur) => [...cur, {
      key: nextKey(), kind: 'block', blockId: block.id, section: block.section, name: block.name, heading: '',
      body: {}, baseText: libraryBodies(block), blockArchived: false, expanded: false,
    }]);
    setPickBlockId('');
  };
  const addText = () => setItems((cur) => [...cur, {
    key: nextKey(), kind: 'text', blockId: null, section: 'closing', name: '', heading: '',
    body: {}, baseText: {}, blockArchived: false, expanded: true,
  }]);

  if (isLoading || !detail) return <Loading />;
  const { template } = detail;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/admin/clients/contracts/templates" className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label={t('contracts.templates.backToTemplates', 'Back to templates') as string}>
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-2xl font-bold flex-1 text-neutral-900 dark:text-neutral-100">{template.name}</h1>
        <span className="text-sm text-neutral-600 dark:text-neutral-400">
          {template.status === 'archived'
            ? t('contracts.templates.status.archived', 'Archived')
            : template.currentVersion
              ? t('contracts.templates.status.published', 'Published · v{{version}}', { version: template.currentVersion })
              : t('contracts.templates.status.draft', 'Draft')}
          {detail.draft && template.currentVersion ? ` · ${t('contracts.templates.unpublished', 'Unpublished changes')}` : ''}
        </span>
      </div>

      {template.isSystem && (
        <Card padding="md" className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm text-neutral-700 dark:text-neutral-300">
            {t('contracts.templates.systemNotice', 'The standard template can\'t be edited. Duplicate it to make a version of your own.')}
          </p>
          <PermissionGate permission="contracts.templates.manage">
            <Button variant="outline" onClick={onDuplicate} disabled={busy}>{t('contracts.templates.duplicate', 'Duplicate')}</Button>
          </PermissionGate>
        </Card>
      )}

      {conflict && (
        <div role="alert" className="p-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-3">
          <p className="flex-1">
            {t('contracts.templates.conflict', 'Someone else saved this template while you were editing. Reload to see their version — the changes you made here since loading will be lost.')}
          </p>
          <Button variant="outline" size="sm" onClick={() => { setConflict(false); void refetch(); }}>
            {t('contracts.templates.reload', 'Reload')}
          </Button>
        </div>
      )}
      {problem && (
        <div role="alert" className="p-3 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30 text-sm text-red-800 dark:text-red-200">
          <ul className="list-disc pl-5 space-y-1">
            {problem.split(' · ').map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      <Card padding="lg" className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('contracts.templates.details', 'Details')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input id="contract-template-name" label={t('contracts.templates.name', 'Name') as string} value={name}
            maxLength={128} readOnly={readOnly} onChange={(e) => setName(e.target.value)} />
          <Input id="contract-template-use-case" label={t('contracts.templates.useCase', 'Use case') as string} value={useCase}
            maxLength={64} readOnly={readOnly} onChange={(e) => setUseCase(e.target.value)} />
          <div className="md:col-span-2">
            <label htmlFor="contract-template-description" className={labelClass}>{t('contracts.templates.description', 'Description')}</label>
            <textarea id="contract-template-description" rows={2} className={fieldClass} value={description}
              maxLength={2000} readOnly={readOnly} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Input id="contract-template-title" label={t('contracts.templates.docTitle', 'Contract title') as string} value={title}
              maxLength={255} readOnly={readOnly} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <LocaleTextField id="contract-template-intro" label={t('contracts.templates.introText', 'Intro text') as string}
          value={intro} onChange={setIntro} readOnly={readOnly} />
        <LocaleTextField id="contract-template-outro" label={t('contracts.templates.outroText', 'Closing text') as string}
          value={outro} onChange={setOutro} rows={2} readOnly={readOnly} />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('contracts.templates.placeholders', 'Placeholders you can use:')}{' '}
          <span className="font-mono">{CONTRACT_PLACEHOLDERS.map((key) => `{{${key}}}`).join(' ')}</span>
        </p>
      </Card>

      <Card padding="lg" className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('contracts.templates.clauses', 'Clauses')}</h2>
        {items.length === 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('contracts.templates.noClauses', 'No clauses yet. Add clauses from the library or free text.')}
          </p>
        )}
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li key={item.key} className="rounded border border-neutral-200 dark:border-neutral-700 p-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400 w-6">{index + 1}.</span>
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200">
                  {item.kind === 'block' ? t('contracts.templates.clause', 'Clause') : t('contracts.templates.freeText', 'Free text')}
                </span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">{t(`contracts.sections.${item.section}`, item.section)}</span>
                <span className="flex-1 min-w-[160px] text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {item.kind === 'block' ? item.name : (item.heading || t('contracts.templates.untitled', 'Untitled'))}
                  {item.kind === 'block' && Object.keys(item.body).length > 0 && (
                    <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">{t('contracts.templates.customised', 'customised')}</span>
                  )}
                  {item.blockArchived && (
                    <span className="ml-2 text-xs font-normal text-red-700 dark:text-red-400">{t('contracts.templates.archivedBlock', 'Archived in the library')}</span>
                  )}
                </span>
                <div className="flex items-center gap-1">
                  <button type="button" className={iconButton} disabled={readOnly || index === 0} onClick={() => move(index, -1)}
                    aria-label={t('contracts.templates.moveUp', 'Move up') as string}><ArrowUp className="w-3.5 h-3.5" /></button>
                  <button type="button" className={iconButton} disabled={readOnly || index === items.length - 1} onClick={() => move(index, 1)}
                    aria-label={t('contracts.templates.moveDown', 'Move down') as string}><ArrowDown className="w-3.5 h-3.5" /></button>
                  <button type="button" className="text-xs underline text-neutral-700 dark:text-neutral-300 px-1"
                    aria-expanded={item.expanded} onClick={() => update(item.key, { expanded: !item.expanded })}>
                    {item.expanded ? t('contracts.templates.hideText', 'Hide text') : t('contracts.templates.showText', 'Text')}
                  </button>
                  {!readOnly && (
                    <button type="button" className={iconButton} onClick={() => remove(item.key)}
                      aria-label={t('contracts.templates.remove', 'Remove') as string}><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              </div>
              {item.expanded && (
                <div className="mt-2 space-y-2">
                  {item.kind === 'text' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div>
                        <label htmlFor={`${item.key}-section`} className={labelClass}>{t('contracts.templates.section', 'Section')}</label>
                        <select id={`${item.key}-section`} className={fieldClass} value={item.section} disabled={readOnly}
                          onChange={(e) => update(item.key, { section: e.target.value as ContractBlockSection })}>
                          {CONTRACT_SECTIONS.map((s) => <option key={s} value={s}>{t(`contracts.sections.${s}`, s)}</option>)}
                        </select>
                      </div>
                      <Input id={`${item.key}-heading`} label={t('contracts.templates.heading', 'Heading') as string}
                        value={item.heading} maxLength={255} readOnly={readOnly}
                        onChange={(e) => update(item.key, { heading: e.target.value })} />
                    </div>
                  )}
                  <LocaleTextField
                    id={`${item.key}-body`}
                    label={item.kind === 'block'
                      ? t('contracts.templates.overrideLabel', 'Text in this template (leave empty to use the clause library\'s text)') as string
                      : t('contracts.templates.body', 'Text') as string}
                    value={item.body}
                    hint={item.baseText}
                    rows={5}
                    readOnly={readOnly}
                    onChange={(body) => update(item.key, { body })}
                  />
                </div>
              )}
            </li>
          ))}
        </ol>

        {!readOnly && (
          <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex-1 min-w-[220px]">
              <label htmlFor="contract-template-pick-block" className={labelClass}>{t('contracts.templates.pickClause', 'Clause from the library')}</label>
              <select id="contract-template-pick-block" className={fieldClass} value={pickBlockId} onChange={(e) => setPickBlockId(e.target.value)}>
                <option value="">—</option>
                {CONTRACT_SECTIONS.filter((s) => blocksBySection.has(s)).map((s) => (
                  <optgroup key={s} label={t(`contracts.sections.${s}`, s) as string}>
                    {(blocksBySection.get(s) || []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <Button variant="outline" onClick={addBlock} disabled={!pickBlockId}>
              <Plus className="w-4 h-4 mr-1" />{t('contracts.templates.addClause', 'Add clause')}
            </Button>
            <Button variant="outline" onClick={addText}>
              <Plus className="w-4 h-4 mr-1" />{t('contracts.templates.addFreeText', 'Add free text')}
            </Button>
          </div>
        )}
      </Card>

      <Card padding="lg" className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('contracts.attachments.heading', 'Attachments')}</h2>
        <AttachmentListEditor idPrefix="contract-template-attachment" value={attachments} onChange={setAttachments} readOnly={readOnly} />
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => onPreview()} disabled={busy}>{t('contracts.templates.preview', 'Preview PDF')}</Button>
        {!readOnly && (
          <PermissionGate permission="contracts.templates.manage">
            <Button variant="outline" onClick={onSave} disabled={busy || !name.trim()}>{t('contracts.templates.saveDraft', 'Save draft')}</Button>
            <Button onClick={onPublish} disabled={busy || !name.trim() || items.length === 0}>{t('contracts.templates.publish', 'Publish')}</Button>
          </PermissionGate>
        )}
      </div>

      <Card padding="lg">
        <h2 className="text-lg font-semibold mb-2 text-neutral-900 dark:text-neutral-100">{t('contracts.templates.versions', 'Versions')}</h2>
        {detail.versions.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('contracts.templates.noVersions', 'Not published yet.')}</p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {detail.versions.map((v) => (
              <li key={v.id} className="py-2 flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">v{v.version}</span>
                <span className="text-neutral-600 dark:text-neutral-400">
                  {v.status === 'published' ? t('contracts.templates.versionCurrent', 'Current') : t('contracts.templates.versionEarlier', 'Earlier')}
                  {v.publishedAt ? ` · ${formatDateTime(v.publishedAt)}` : ''}
                </span>
                {v.contentSha256 && (
                  <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400" title={v.contentSha256}>
                    {v.contentSha256.slice(0, 12)}
                  </span>
                )}
                <span className="flex-1" />
                <Button variant="outline" size="sm" disabled={busy} onClick={() => onPreview(v.version)}>
                  {t('contracts.templates.preview', 'Preview PDF')}
                </Button>
                {!readOnly && (
                  <PermissionGate permission="contracts.templates.manage">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => onDraftFromVersion(v.version)}>
                      {t('contracts.templates.draftFromVersion', 'New draft from this version')}
                    </Button>
                  </PermissionGate>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
