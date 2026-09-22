/**
 * Admin → Contracts → Templates → one template (#1445).
 *
 * The working copy is the template's draft (made from the published version
 * on the first save). Clauses are clause-library blocks — optionally with
 * this template's own text per language — or free-text sections, in the
 * order shown. Publishing freezes a version; earlier versions stay in the
 * history and can start a new draft.
 *
 * Editing: changes save themselves two seconds after the last one (the
 * button saves at once), with the state shown in a live region. Every save
 * sends the lockVersion it last got back; when another admin saved in
 * between, autosave stops and nothing here is thrown away — compare, keep
 * yours, or take theirs. Undo/redo covers the whole draft (typing in one
 * field folds into one step; inside a text field the browser's own undo
 * applies). Clauses move by drag handle, keyboard, the arrow buttons or
 * Alt+↑/↓, and the last check's page breaks are drawn between them.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Redo2, Undo2 } from 'lucide-react';
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
  contractTemplatesService, templateError,
  type ContractLocale, type ContractTemplateDetail, type ContractTemplateDraftPayload, type LocaleText,
  type TemplateFinding, type TemplatePublishCheck,
} from '../../../services/contractTemplates.service';
import { TemplateCheckPanel } from './TemplateCheckPanel';
import { LocaleTextField, fieldClass, iconButton, labelClass } from './TemplateEditorFields';
import { TemplateClauseList, type DraftItem } from './TemplateClauseList';
import { VersionCompareModal } from './VersionCompareModal';
import type { ComparableVersion } from './templateDiff';
import { useEditHistory } from './useEditHistory';
import { ContractModal } from './ContractModal';
import { ContractLayoutPreview } from '../../../components/contracts/ContractLayoutPreview';
import type { ContractBodyContent } from '../../../services/contracts.service';

/** Ask a text field to show a language and take the focus ("Go to" from the check). */
interface FocusRequest {
  target: string;
  locale: ContractLocale;
  nonce: number;
}

/** Everything the editor edits — one value, so undo/redo and "unsaved" see all of it. */
interface EditorDraft {
  name: string;
  description: string;
  useCase: string;
  title: string;
  intro: LocaleText;
  outro: LocaleText;
  items: DraftItem[];
  attachments: AttachmentRow[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict';

const AUTOSAVE_MS = 2000;

const EMPTY: EditorDraft = {
  name: '', description: '', useCase: '', title: '', intro: {}, outro: {}, items: [], attachments: [],
};

const toAttachmentRows = (list?: IncludedAttachment[]): AttachmentRow[] => (list || []).map((a) => ({ attachmentId: a.attachmentId, delivery: a.delivery, name: a.name, pages: a.pages, bytes: a.bytes, isActive: a.isActive }));

let keyCounter = 0;
const nextKey = () => {
  keyCounter += 1;
  return `clause-${keyCounter}`;
};

function libraryBodies(block: ContractBlock): LocaleText {
  const out: LocaleText = {};
  const pairs: Array<[ContractLocale, string | null]> = [
    ['en', block.bodyText], ['de', block.bodyTextDe], ['ru', block.bodyTextRu],
    ['pt', block.bodyTextPt], ['nl', block.bodyTextNl], ['fr', block.bodyTextFr],
  ];
  for (const [locale, text] of pairs) if (text && text.trim()) out[locale] = text;
  return out;
}

function draftFromDetail(detail: ContractTemplateDetail): EditorDraft {
  const source = detail.draft || detail.published;
  return {
    name: detail.template.name,
    description: detail.template.description || '',
    useCase: detail.template.useCase || '',
    title: source?.title || '',
    intro: source?.introText || {},
    outro: source?.outroText || {},
    items: (source?.items || []).map((item) => ({
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
    })),
    attachments: toAttachmentRows(source?.attachments),
  };
}

/** What a save sends (without the lock). */
function payloadOf(draft: EditorDraft): Omit<ContractTemplateDraftPayload, 'lockVersion'> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    useCase: draft.useCase.trim() || null,
    title: draft.title.trim() || null,
    introText: draft.intro,
    outroText: draft.outro,
    items: draft.items.map((item) => (item.kind === 'block'
      ? { kind: 'block', blockId: item.blockId, body: item.body }
      : { kind: 'text', section: item.section, heading: item.heading.trim() || null, body: item.body })),
    attachments: draft.attachments.map((a) => ({ attachmentId: a.attachmentId, delivery: a.delivery })),
  };
}

const serialize = (draft: EditorDraft) => JSON.stringify(payloadOf(draft));

const comparableOf = (draft: EditorDraft): ComparableVersion => ({
  meta: { name: draft.name.trim(), description: draft.description.trim(), useCase: draft.useCase.trim() },
  title: draft.title,
  introText: draft.intro,
  outroText: draft.outro,
  items: draft.items.map((item) => ({
    kind: item.kind, blockId: item.blockId, section: item.section, heading: item.heading || null,
    body: item.body, snapshot: item.baseText, name: item.name,
  })),
  attachments: draft.attachments.map((a) => ({ attachmentId: a.attachmentId, name: a.name, delivery: a.delivery })),
});

/** Is the key press meant for a text field's own undo? */
const inTextField = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable);
};

const isNetworkError = (err: unknown) => {
  const e = err as { response?: unknown; request?: unknown; code?: string };
  return !e?.response && (!!e?.request || e?.code === 'ERR_NETWORK');
};

export const ContractTemplateEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const templateId = Number(id);
  const queryKey = useMemo(() => ['contract-template', templateId], [templateId]);
  const queryClient = useQueryClient();
  const { formatDateTime, formatTime } = useLocalizedDate();

  const { data: detail, isLoading } = useQuery({
    queryKey,
    queryFn: () => contractTemplatesService.get(templateId),
    enabled: Number.isFinite(templateId),
  });
  const { data: library } = useQuery({
    queryKey: ['contracts', 'blocks-library'],
    queryFn: () => contractsService.listBlocks({ includeInactive: false }),
  });

  const history = useEditHistory<EditorDraft>(EMPTY);
  const draft = history.present;
  const { change, undo, redo, reset, replace } = history;
  const draftSerial = useMemo(() => serialize(draft), [draft]);

  // What the server has: the serialized draft and the lock it was saved with.
  const [savedSerial, setSavedSerial] = useState<string | null>(null);
  const lockRef = useRef(1);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The template the editor holds (navigating to a copy loads the copy).
  const loadedFor = useRef<number | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const saving = useRef<Promise<ContractTemplateDetail | null> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The last pre-publication check, and the draft it checked.
  const [check, setCheck] = useState<TemplatePublishCheck | null>(null);
  const [checkedSerial, setCheckedSerial] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  // "Compare with previous", or theirs against mine after a conflict.
  const [comparing, setComparing] = useState<{ before: ComparableVersion; after: ComparableVersion; title: string; subtitle: string; conflict?: boolean } | null>(null);
  const [pickBlockId, setPickBlockId] = useState('');
  // The signing page as a contract from this draft would show it (sample data).
  const [layout, setLayout] = useState<ContractBodyContent | null>(null);

  const dirty = savedSerial !== null && draftSerial !== savedSerial;
  const readOnly = !detail || detail.template.isSystem || detail.template.status === 'archived';
  const conflict = saveState === 'conflict';

  /** Put a server copy into the editor: first load, "take theirs", publish, a draft from a version. */
  const load = useCallback((next: ContractTemplateDetail, mode: 'reset' | 'step' = 'reset') => {
    const value = draftFromDetail(next);
    if (mode === 'reset') reset(value);
    else replace(value);
    setSavedSerial(serialize(value));
    lockRef.current = next.template.lockVersion;
    setExpanded(new Set());
  }, [reset, replace]);

  // The first server copy becomes the editor's state; later refetches don't
  // overwrite what is being edited.
  useEffect(() => {
    if (!detail || loadedFor.current === detail.template.id) return;
    loadedFor.current = detail.template.id;
    load(detail);
    setCheck(null);
    setSaveState('idle');
  }, [detail, load]);

  const store = (next: ContractTemplateDetail) => {
    queryClient.setQueryData(queryKey, next);
    void queryClient.invalidateQueries({ queryKey: ['contract-templates'] });
  };

  const fail = (err: unknown, fallback: string) => {
    const { message, code, findings } = templateError(err);
    if (code === 'TEMPLATE_CONFLICT') setSaveState('conflict');
    else if (code === 'TEMPLATE_INVALID' && findings) showCheck({ ok: false, pageCount: null, itemPages: [], findings });
    else setProblem(message || fallback);
  };

  /** `checked`: the draft the result is for — taken before the request, since the fields stay editable while it runs. */
  const showCheck = (result: TemplatePublishCheck, checked: string = serialize(draftRef.current)) => {
    setCheck(result);
    setCheckedSerial(checked);
  };

  /**
   * Save what is in the editor now. One save at a time: a call while one
   * runs waits for it and then saves again if anything changed meanwhile.
   * Resolves with the server's copy, or null when the save failed (the
   * state says why; nothing local is dropped).
   */
  const saveNow = useCallback(async (extra: Partial<ContractTemplateDraftPayload> = {}): Promise<ContractTemplateDetail | null> => {
    if (saving.current) await saving.current;
    const snapshot = draftRef.current;
    const serial = serialize(snapshot);
    const run = (async () => {
      setSaveState('saving');
      setProblem(null);
      try {
        const saved = await contractTemplatesService.saveDraft(templateId, { lockVersion: lockRef.current, ...payloadOf(snapshot), ...extra });
        lockRef.current = saved.template.lockVersion;
        setSavedSerial(serial);
        setSavedAt(new Date());
        setSaveState('saved');
        store(saved);
        return saved;
      } catch (err) {
        const { code, message } = templateError(err);
        if (code === 'TEMPLATE_CONFLICT') setSaveState('conflict');
        else if (isNetworkError(err)) setSaveState('offline');
        else {
          setSaveState('error');
          setProblem(message || t('contracts.templates.saveFailed', 'The draft could not be saved.') as string);
        }
        return null;
      }
    })();
    saving.current = run;
    try {
      return await run;
    } finally {
      if (saving.current === run) saving.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // Autosave: two seconds after the last change, unless a conflict or an
  // error is waiting for the admin.
  useEffect(() => {
    if (!dirty || readOnly || saveState === 'conflict' || saveState === 'error' || saveState === 'saving') return undefined;
    const timer = setTimeout(() => { void saveNow(); }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draftSerial, dirty, readOnly, saveState, saveNow]);

  // Offline: try again as soon as the browser is back online.
  useEffect(() => {
    if (saveState !== 'offline') return undefined;
    const retry = () => { void saveNow(); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [saveState, saveNow]);

  // Leaving with unsaved changes asks first — registered only while there are some.
  useEffect(() => {
    if (!dirty && saveState !== 'saving') return undefined;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, saveState]);

  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z outside text fields (inside one, the field's own undo).
  useEffect(() => {
    if (readOnly) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || inTextField(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [readOnly, undo, redo]);

  const onSave = async () => {
    setBusy(true);
    const saved = await saveNow();
    setBusy(false);
    if (saved) toast.success(t('contracts.templates.saved', 'Draft saved'));
  };

  /** Save, then run the check on what was saved. Null when either failed. */
  const runCheck = async (): Promise<{ saved: ContractTemplateDetail | null; result: TemplatePublishCheck } | null> => {
    let saved: ContractTemplateDetail | null = null;
    // An edit made from here on is not in what the server checks: the result
    // then shows as stale. (Taken before the save, so at worst an edit made
    // while an earlier save finished counts as unchecked too.)
    const checked = serialize(draftRef.current);
    if (dirty || !detail?.draft) {
      saved = await saveNow();
      if (!saved) return null;
    }
    try {
      const result = await contractTemplatesService.check(templateId);
      showCheck(result, checked);
      return { saved, result };
    } catch (err) {
      fail(err, t('contracts.templates.check.failed', 'The check could not be run.') as string);
      return null;
    }
  };

  const onCheck = async () => {
    setBusy(true);
    await runCheck();
    setBusy(false);
  };

  const onPublish = async () => {
    setBusy(true);
    try {
      // The check first: errors stay on screen with their "Go to", and the
      // draft is not touched. The server runs the same check again.
      const checked = await runCheck();
      if (!checked || !checked.result.ok) return;
      const published = await contractTemplatesService.publish(templateId, lockRef.current);
      store(published);
      load(published);
      setCheck(null);
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
      if (!version && !readOnly && (dirty || !detail?.draft) && !(await saveNow())) return;
      const url = await contractTemplatesService.previewUrl(templateId, version);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      fail(err, t('contracts.templates.previewFailed', 'The preview could not be rendered.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onLayoutPreview = async () => {
    setBusy(true);
    try {
      if (!readOnly && (dirty || !detail?.draft) && !(await saveNow())) return;
      setLayout(await contractTemplatesService.previewContent(templateId));
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
      const next = await contractTemplatesService.draftFromVersion(templateId, version, lockRef.current);
      store(next);
      load(next);
      toast.success(t('contracts.templates.draftCreated', 'Draft created from version {{version}}', { version }));
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onCompare = async (version: number, previous: number) => {
    setBusy(true);
    try {
      const [before, after] = await Promise.all([
        contractTemplatesService.version(templateId, previous),
        contractTemplatesService.version(templateId, version),
      ]);
      const comparable = (v: typeof before): ComparableVersion => ({
        title: v.title, introText: v.introText, outroText: v.outroText, items: v.items || [], attachments: v.attachments || [],
      });
      setComparing({
        before: comparable(before),
        after: comparable(after),
        title: t('contracts.templates.compare.title', 'Changes in v{{version}}', { version }) as string,
        subtitle: t('contracts.templates.compare.subtitle', 'v{{from}} → v{{to}}', { from: previous, to: version }) as string,
      });
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  // ---- the source template moved on (lineage) ------------------------
  const lineage = detail?.lineage || null;

  const loadSourceVersion = (n: number) => contractTemplatesService.version(lineage!.sourceTemplateId, n);

  const onLineageCompare = async () => {
    if (!lineage || !lineage.latestSourceVersion) return;
    setBusy(true);
    try {
      const [before, after] = await Promise.all([
        lineage.sourceVersion ? loadSourceVersion(lineage.sourceVersion) : Promise.resolve(null),
        loadSourceVersion(lineage.latestSourceVersion),
      ]);
      const comparable = (v: typeof after | null): ComparableVersion => (v ? {
        title: v.title, introText: v.introText, outroText: v.outroText, items: v.items || [], attachments: v.attachments || [],
      } : { title: '', introText: {}, outroText: {}, items: [], attachments: [] });
      setComparing({
        before: comparable(before),
        after: comparable(after),
        title: t('contracts.templates.lineage.compareTitle', 'What changed in “{{name}}”', { name: lineage.sourceName }) as string,
        subtitle: t('contracts.templates.compare.subtitle', 'v{{from}} → v{{to}}',
          { from: lineage.sourceVersion ?? '—', to: lineage.latestSourceVersion }) as string,
      });
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  /** Append the source's clauses this draft doesn't have, and mark the new version as reviewed. */
  const onLineageAdopt = async () => {
    if (!lineage || !lineage.latestSourceVersion) return;
    setBusy(true);
    try {
      const latest = await loadSourceVersion(lineage.latestSourceVersion);
      const have = new Set(draftRef.current.items.map((item) => (item.kind === 'block' ? `b:${item.blockId}` : `t:${item.heading.trim().toLowerCase()}`)));
      const added: DraftItem[] = (latest.items || [])
        .filter((item) => !have.has(item.kind === 'block' ? `b:${item.blockId}` : `t:${(item.heading || '').trim().toLowerCase()}`))
        .map((item) => ({
          key: nextKey(),
          kind: item.kind,
          blockId: item.blockId,
          section: item.section,
          name: item.block?.name || '',
          heading: item.heading || '',
          body: item.body || {},
          baseText: item.kind === 'block' ? (item.snapshot && Object.keys(item.snapshot).length ? item.snapshot : item.block?.bodies || {}) : {},
          blockArchived: false,
        }));
      if (added.length) change((cur) => ({ ...cur, items: [...cur.items, ...added] }));
      draftRef.current = { ...draftRef.current, items: [...draftRef.current.items, ...added] };
      const saved = await saveNow({ sourceVersionNumber: lineage.latestSourceVersion });
      if (saved) {
        toast.success(added.length
          ? t('contracts.templates.lineage.adopted', '{{count}} new clauses added at the end', { count: added.length })
          : t('contracts.templates.lineage.nothingNew', 'Nothing new to add — marked as reviewed'));
      }
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onLineageDismiss = async () => {
    if (!lineage || !lineage.latestSourceVersion) return;
    setBusy(true);
    await saveNow({ sourceVersionNumber: lineage.latestSourceVersion });
    setBusy(false);
  };

  // ---- the conflict: nothing here is lost, the admin decides ----------
  const fetchTheirs = () => contractTemplatesService.get(templateId);

  const onConflictCompare = async () => {
    setBusy(true);
    try {
      const theirs = await fetchTheirs();
      setComparing({
        before: comparableOf(draftFromDetail(theirs)),
        after: comparableOf(draftRef.current),
        title: t('contracts.templates.conflictCompareTitle', 'Their version and yours') as string,
        subtitle: t('contracts.templates.conflictCompareSubtitle', 'What you would change in the version saved by someone else') as string,
        conflict: true,
      });
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onKeepMine = async () => {
    setBusy(true);
    setComparing(null);
    try {
      const theirs = await fetchTheirs();
      store(theirs);
      lockRef.current = theirs.template.lockVersion;
      setSaveState('idle');
      const saved = await saveNow();
      if (saved) toast.success(t('contracts.templates.keptMine', 'Your version is saved'));
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  const onTakeTheirs = async () => {
    setBusy(true);
    setComparing(null);
    try {
      const theirs = await fetchTheirs();
      store(theirs);
      // A step of its own: Undo brings your version back.
      load(theirs, 'step');
      setSaveState('idle');
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
        t('contracts.templates.copyName', '{{name}} (copy)', { name: draft.name }) as string);
      void queryClient.invalidateQueries({ queryKey: ['contract-templates'] });
      navigate(`/admin/clients/contracts/templates/${copy.template.id}`);
    } catch (err) {
      fail(err, t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.') as string);
    } finally {
      setBusy(false);
    }
  };

  // ---- editing ---------------------------------------------------------
  const setField = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K], coalesce?: string) => {
    change((cur) => ({ ...cur, [key]: value }), coalesce);
  };
  const move = (from: number, to: number) => change((cur) => {
    if (to < 0 || to >= cur.items.length || from === to) return cur;
    const items = [...cur.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    return { ...cur, items };
  });
  const update = (key: string, patch: Partial<DraftItem>, coalesce?: string) => change(
    (cur) => ({ ...cur, items: cur.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }),
    coalesce,
  );
  const remove = (key: string) => change((cur) => ({ ...cur, items: cur.items.filter((it) => it.key !== key) }));
  const toggle = (key: string) => setExpanded((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const addBlock = () => {
    const block = library?.blocks.find((b) => b.id === Number(pickBlockId));
    if (!block) return;
    change((cur) => ({
      ...cur,
      items: [...cur.items, {
        key: nextKey(), kind: 'block', blockId: block.id, section: block.section, name: block.name, heading: '',
        body: {}, baseText: libraryBodies(block), blockArchived: false,
      }],
    }));
    setPickBlockId('');
  };
  const addText = () => {
    const key = nextKey();
    change((cur) => ({
      ...cur,
      items: [...cur.items, {
        key, kind: 'text', blockId: null, section: 'closing', name: '', heading: '', body: {}, baseText: {}, blockArchived: false,
      }],
    }));
    setExpanded((cur) => new Set(cur).add(key));
  };

  const goTo = (finding: TemplateFinding) => {
    const locale = (finding.locale || 'de') as ContractLocale;
    if (finding.field) {
      setFocus({ target: finding.field, locale, nonce: Date.now() });
      return;
    }
    if (finding.itemPosition) {
      const item = draft.items[finding.itemPosition - 1];
      if (!item) return;
      setExpanded((cur) => new Set(cur).add(item.key));
      setFocus({ target: item.key, locale, nonce: Date.now() });
      return;
    }
    if (finding.attachmentId) {
      const card = document.getElementById('contract-template-attachments');
      card?.scrollIntoView?.({ block: 'center' });
      card?.focus();
    }
  };
  const focusFor = (target: string) => (focus && focus.target === target ? { locale: focus.locale, nonce: focus.nonce } : null);

  const blocksBySection = useMemo(() => {
    const out = new Map<ContractBlockSection, ContractBlock[]>();
    for (const block of library?.blocks || []) {
      out.set(block.section, [...(out.get(block.section) || []), block]);
    }
    return out;
  }, [library]);

  if (isLoading || !detail) return <Loading />;
  const { template } = detail;
  const checkStale = check !== null && checkedSerial !== draftSerial;

  const status = (() => {
    if (saveState === 'saving') return t('contracts.templates.autosave.saving', 'Saving…');
    if (saveState === 'conflict') return t('contracts.templates.autosave.conflict', 'Not saved — changed by someone else');
    if (saveState === 'offline') return t('contracts.templates.autosave.offline', 'Offline — your changes are kept here');
    if (saveState === 'error') return t('contracts.templates.autosave.error', 'Not saved');
    if (dirty) return t('contracts.templates.autosave.unsaved', 'Unsaved changes');
    if (savedAt) return t('contracts.templates.autosave.saved', 'Saved {{time}}', { time: formatTime(savedAt) });
    return t('contracts.templates.autosave.upToDate', 'No unsaved changes');
  })();

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

      {lineage && lineage.updateAvailable && !readOnly && (
        <div role="status" className="p-3 rounded-md border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-sm text-blue-900 dark:text-blue-100 flex flex-wrap items-center gap-3">
          <p className="flex-1">
            {lineage.sourceIsSystem
              ? t('contracts.templates.lineage.systemUpdated', 'The system template was updated (v{{from}} → v{{to}}). Your copy is unchanged.',
                { from: lineage.sourceVersion ?? '—', to: lineage.latestSourceVersion })
              : t('contracts.templates.lineage.sourceUpdated', '“{{name}}”, which this template was copied from, has a newer version (v{{from}} → v{{to}}). Your copy is unchanged.',
                { name: lineage.sourceName, from: lineage.sourceVersion ?? '—', to: lineage.latestSourceVersion })}
          </p>
          <Button variant="outline" size="sm" onClick={onLineageCompare} disabled={busy}>{t('contracts.templates.conflictCompare', 'Compare')}</Button>
          <Button variant="outline" size="sm" onClick={onLineageAdopt} disabled={busy || conflict}>
            {t('contracts.templates.lineage.adopt', 'Add the new clauses to my draft')}
          </Button>
          <Button variant="outline" size="sm" onClick={onLineageDismiss} disabled={busy || conflict}>
            {t('contracts.templates.lineage.dismiss', 'Mark as reviewed')}
          </Button>
        </div>
      )}

      {!readOnly && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 p-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95">
          <button type="button" className={iconButton} disabled={!history.canUndo} onClick={undo}
            aria-label={t('contracts.templates.undo', 'Undo') as string} title={t('contracts.templates.undoHint', 'Undo (Ctrl+Z)') as string}>
            <Undo2 className="w-4 h-4" />
          </button>
          <button type="button" className={iconButton} disabled={!history.canRedo} onClick={redo}
            aria-label={t('contracts.templates.redo', 'Redo') as string} title={t('contracts.templates.redoHint', 'Redo (Shift+Ctrl+Z)') as string}>
            <Redo2 className="w-4 h-4" />
          </button>
          <span role="status" aria-live="polite" data-testid="autosave-status"
            className={`text-sm ${saveState === 'conflict' || saveState === 'error' ? 'text-red-700 dark:text-red-400'
              : saveState === 'offline' || dirty ? 'text-amber-800 dark:text-amber-300' : 'text-neutral-600 dark:text-neutral-400'}`}>
            {status}
          </span>
        </div>
      )}

      {conflict && (
        <div role="alert" className="p-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-3">
          <p className="flex-1">
            <strong>{t('contracts.templates.conflictTitle', 'Changed by someone else.')}</strong>{' '}
            {t('contracts.templates.conflictBody', 'Another admin saved this template while you were editing. Autosave is paused and your changes are still here.')}
          </p>
          <Button variant="outline" size="sm" onClick={onConflictCompare} disabled={busy}>{t('contracts.templates.conflictCompare', 'Compare')}</Button>
          <Button variant="outline" size="sm" onClick={onKeepMine} disabled={busy}>{t('contracts.templates.keepMine', 'Keep mine')}</Button>
          <Button variant="outline" size="sm" onClick={onTakeTheirs} disabled={busy}>{t('contracts.templates.takeTheirs', 'Take theirs')}</Button>
        </div>
      )}
      {problem && (
        <div role="alert" className="p-3 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30 text-sm text-red-800 dark:text-red-200">
          {problem}
        </div>
      )}
      {check && (
        <div role="status" aria-live="polite">
          <TemplateCheckPanel
            check={check}
            stale={checkStale}
            onGoTo={goTo}
            labels={{
              clauseName: (position) => {
                const item = draft.items[position - 1];
                return item ? (item.kind === 'block' ? item.name : item.heading) || null : null;
              },
              attachmentName: (attachmentId) => draft.attachments.find((a) => a.attachmentId === attachmentId)?.name || null,
            }}
          />
        </div>
      )}

      <Card padding="lg" className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('contracts.templates.details', 'Details')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input id="contract-template-name" label={t('contracts.templates.name', 'Name') as string} value={draft.name}
            maxLength={128} readOnly={readOnly} onChange={(e) => setField('name', e.target.value, 'name')} />
          <Input id="contract-template-use-case" label={t('contracts.templates.useCase', 'Use case') as string} value={draft.useCase}
            maxLength={64} readOnly={readOnly} onChange={(e) => setField('useCase', e.target.value, 'useCase')} />
          <div className="md:col-span-2">
            <label htmlFor="contract-template-description" className={labelClass}>{t('contracts.templates.description', 'Description')}</label>
            <textarea id="contract-template-description" rows={2} className={fieldClass} value={draft.description}
              maxLength={2000} readOnly={readOnly} onChange={(e) => setField('description', e.target.value, 'description')} />
          </div>
          <div className="md:col-span-2">
            <Input id="contract-template-title" label={t('contracts.templates.docTitle', 'Contract title') as string} value={draft.title}
              maxLength={255} readOnly={readOnly} onChange={(e) => setField('title', e.target.value, 'title')} />
          </div>
        </div>
        <LocaleTextField id="contract-template-intro" label={t('contracts.templates.introText', 'Intro text') as string}
          value={draft.intro} onChange={(value, locale) => setField('intro', value, `intro:${locale}`)} readOnly={readOnly}
          focusRequest={focusFor('intro')} />
        <LocaleTextField id="contract-template-outro" label={t('contracts.templates.outroText', 'Closing text') as string}
          value={draft.outro} onChange={(value, locale) => setField('outro', value, `outro:${locale}`)} rows={2} readOnly={readOnly}
          focusRequest={focusFor('outro')} />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('contracts.templates.placeholdersHint', 'Placeholders are filled in when a contract is made. Use “Insert placeholder” next to a text; the preview shows them with sample data.')}
        </p>
      </Card>

      <Card padding="lg" className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('contracts.templates.clauses', 'Clauses')}</h2>
        {draft.items.length === 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('contracts.templates.noClauses', 'No clauses yet. Add clauses from the library or free text.')}
          </p>
        )}
        {!readOnly && draft.items.length > 1 && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('contracts.templates.reorderHint', 'Reorder with the handle, the arrow buttons, or Alt+↑/↓ on a clause.')}
            {check ? '' : ` ${t('contracts.templates.pageBreaks.hint', 'Run “Check” to see where the pages break.')}`}
          </p>
        )}
        <TemplateClauseList
          items={draft.items}
          expanded={expanded}
          readOnly={readOnly}
          itemPages={check ? check.itemPages : null}
          pagesStale={checkStale}
          onMove={move}
          onToggle={toggle}
          onRemove={remove}
          onUpdate={update}
          focusFor={focusFor}
        />

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
        <h2 id="contract-template-attachments" tabIndex={-1} className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 focus:outline-none">
          {t('contracts.attachments.heading', 'Attachments')}
        </h2>
        <AttachmentListEditor idPrefix="contract-template-attachment" value={draft.attachments}
          onChange={(attachments) => setField('attachments', attachments)} readOnly={readOnly} />
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onLayoutPreview} disabled={busy}>{t('contracts.templates.layoutPreview', 'Preview signing page')}</Button>
        <Button variant="outline" onClick={() => onPreview()} disabled={busy}>{t('contracts.templates.preview', 'Preview PDF')}</Button>
        {!readOnly && (
          <PermissionGate permission="contracts.templates.manage">
            <Button variant="outline" onClick={onCheck} disabled={busy || conflict || !draft.name.trim()}>{t('contracts.templates.check.run', 'Check')}</Button>
            <Button variant="outline" onClick={onSave} disabled={busy || conflict || !draft.name.trim()}>{t('contracts.templates.saveDraft', 'Save draft')}</Button>
            <Button onClick={onPublish} disabled={busy || conflict || !draft.name.trim() || draft.items.length === 0}>{t('contracts.templates.publish', 'Publish')}</Button>
          </PermissionGate>
        )}
      </div>

      <Card padding="lg">
        <h2 className="text-lg font-semibold mb-2 text-neutral-900 dark:text-neutral-100">{t('contracts.templates.versions', 'Versions')}</h2>
        {detail.versions.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('contracts.templates.noVersions', 'Not published yet.')}</p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {detail.versions.map((v, index) => (
              <li key={v.id} className="py-2 flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">v{v.version}</span>
                <span className="text-neutral-600 dark:text-neutral-400">
                  {v.status === 'published' ? t('contracts.templates.versionCurrent', 'Current') : t('contracts.templates.versionEarlier', 'Earlier')}
                  {v.publishedAt ? ` · ${formatDateTime(v.publishedAt)}` : ''}
                  {' · '}
                  {v.publishedBy
                    ? t('contracts.templates.publishedBy', 'published by {{name}}', { name: v.publishedBy.username })
                    : t('contracts.templates.publishedBySystem', 'built in')}
                </span>
                {v.contentSha256 && (
                  <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400" title={v.contentSha256}>
                    {v.contentSha256.slice(0, 12)}
                  </span>
                )}
                <span className="flex-1" />
                {detail.versions[index + 1] && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => onCompare(v.version, detail.versions[index + 1].version)}>
                    {t('contracts.templates.compare.withPrevious', 'Compare with previous')}
                  </Button>
                )}
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

      {layout && (
        <ContractModal
          titleId="contract-template-layout-title"
          title={t('contracts.templates.layoutPreviewTitle', 'Signing page with sample data')}
          onClose={() => setLayout(null)}
          width="max-w-5xl"
        >
          <ContractLayoutPreview content={layout} idPrefix="contract-template-layout" />
        </ContractModal>
      )}
      {comparing && (
        <VersionCompareModal
          before={comparing.before}
          after={comparing.after}
          title={comparing.title}
          subtitle={comparing.subtitle}
          onClose={() => setComparing(null)}
          footer={comparing.conflict ? (
            <>
              <Button variant="outline" onClick={onTakeTheirs} disabled={busy}>{t('contracts.templates.takeTheirs', 'Take theirs')}</Button>
              <Button onClick={onKeepMine} disabled={busy}>{t('contracts.templates.keepMine', 'Keep mine')}</Button>
            </>
          ) : undefined}
        />
      )}
    </div>
  );
};
