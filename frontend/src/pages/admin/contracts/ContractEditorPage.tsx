/**
 * Admin → Contract editor.
 *
 * Two modes:
 *   - /admin/clients/contracts/new       — create a fresh draft after
 *     picking a customer (server seeds inclusions from active system
 *     blocks).
 *   - /admin/clients/contracts/:id/edit  — edit an existing draft
 *     (scalars + block on/off + within-section ordering).
 *
 * Sent contracts can't be edited (locked at the service layer); admin
 * cancels + creates a fresh one for amendments.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Eye, Save } from 'lucide-react';
import { Button, Card, Input, Loading, LocalizedDateInput, TimeField } from '../../../components/common';
import {
  contractsService,
  type ContractBlockSection,
  CONTRACT_SECTIONS,
} from '../../../services/contracts.service';
import { CustomerPicker } from '../../../components/admin/CustomerPicker';
import { ProjectSelect } from '../../../components/admin/ProjectSelect';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { describeSaveError, newIdempotencyKey, type SaveErrorView } from './contractSaveError';

const CRM_DISCLAIMER_URL = 'https://docs.picpeak.app/features/crm/disclaimers';

interface BlockRow {
  blockId: number;
  section: ContractBlockSection;
  name: string;
  description: string | null;
  isSystem: boolean;
  included: boolean;
  position: number;
}

export const ContractEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);
  const numericId = id ? parseInt(id, 10) : null;

  const [customerAccountId, setCustomerAccountId] = useState<number | null>(null);
  // Customer label + passive flag mirror the QuoteEditorPage chip so
  // the admin sees the real name (company / first+last / display name)
  // and a "Passive — admin only" badge when the customer has no
  // portal access. Without these the chip would just say "#3".
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerIsPassive, setCustomerIsPassive] = useState(false);
  // Customer search state moved into <CustomerPicker> (C.5).
  const [title, setTitle] = useState('');
  // Event snapshot fields. Mirror the quote editor so the same
  // "Wedding Doe / Müller" label flows quote → contract → invoice.
  // Standalone contracts (no source quote) set these directly here.
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventTimeStart, setEventTimeStart] = useState('');
  const [eventTimeEnd, setEventTimeEnd] = useState('');
  const [introText, setIntroText] = useState('');
  const [outroText, setOutroText] = useState('');
  const [language, setLanguage] = useState('de');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [validUntil, setValidUntil] = useState('');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);

  // Why the last save failed, shown inline instead of a toast that vanished
  // before the admin could read which field was wrong or whether a draft now
  // existed (issue 1447).
  const [saveError, setSaveError] = useState<SaveErrorView | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  // One key per attempt to create this draft, kept across retries until a
  // create succeeds. When a response is lost after the server committed, the
  // retry carries the same key and gets the existing draft back instead of a
  // second one.
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey());
  // Set once a retry turned out to be a replay: that draft exists, so further
  // saves from this page update it instead of creating one.
  const replayedDraftIdRef = useRef<number | null>(null);
  // isPending only flips on the next render, so two clicks in the same tick
  // would both get past the disabled button and send two requests.
  const submittingRef = useRef(false);

  // Prefill the customer when opened as "new contract for this customer"
  // (?customerAccountId=42), e.g. from the Messages view. New contracts only;
  // mirrors QuoteEditorPage / BillEditorPage.
  useEffect(() => {
    if (isEdit || customerAccountId) return;
    const raw = searchParams.get('customerAccountId');
    const cid = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await customerAdminService.get(cid);
        if (cancelled) return;
        setCustomerAccountId(c.id);
        setCustomerLabel(c.companyName || c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email);
        setCustomerIsPassive(Boolean(c.isPassive));
        if (c.preferredLanguage) setLanguage(c.preferredLanguage);
      } catch { /* ignore — admin can still pick manually */ }
    })();
    return () => { cancelled = true; };
  }, [isEdit, searchParams, customerAccountId]);

  // Load existing contract on edit.
  const { data: existing, isLoading: existingLoading } = useQuery({
    queryKey: ['contract', numericId],
    queryFn: () => contractsService.get(numericId as number),
    enabled: isEdit && numericId !== null,
  });

  // For new contracts, fetch every active block in the library so the
  // admin can opt-IN to non-system blocks (system blocks are pre-toggled
  // on by the server on create). We still show them all here for parity
  // with the edit flow.
  const { data: blockLibrary } = useQuery({
    queryKey: ['contracts', 'blocks-library'],
    queryFn: () => contractsService.listBlocks({ includeInactive: false }),
  });

  // Customer search moved into <CustomerPicker> (C.5).

  // Hydrate state from server when the existing contract loads.
  useEffect(() => {
    if (!existing) return;
    const c = existing.contract;
    setCustomerAccountId(c.customerAccountId);
    setCustomerLabel(
      c.customer.companyName
      || [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ')
      || c.customer.displayName
      || c.customer.email
      || `#${c.customerAccountId}`,
    );
    // Backend transformContract doesn't currently surface isPassive
    // for contracts. Default to false; the chip just won't show the
    // badge in that case. (Quote/Bill detail compute this via the
    // customer.password_hash join — wire later if needed.)
    setCustomerIsPassive(false);
    setTitle(c.title || '');
    setEventName(c.eventName || '');
    setEventDate(c.eventDate || '');
    setEventTimeStart(c.eventTimeStart || '');
    setEventTimeEnd(c.eventTimeEnd || '');
    setIntroText(c.introText || '');
    setOutroText(c.outroText || '');
    setLanguage(c.language || 'de');
    setIssueDate(c.issueDate);
    setValidUntil(c.validUntil || '');
    setProjectId(c.projectId ?? null);
    setBlocks((c.inclusions || []).map((inc) => ({
      blockId: inc.blockId,
      section: inc.section,
      name: inc.block?.name || `Block ${inc.blockId}`,
      description: inc.block?.description ?? null,
      isSystem: inc.block?.isSystem === true,
      included: inc.included,
      position: inc.position,
    })));
  }, [existing]);

  // When creating new (no existing contract loaded yet), seed blocks
  // state from the library once it arrives so the admin can preview
  // the inclusion list before saving. The server will replace these
  // positions deterministically on create, but the UI shape matches.
  useEffect(() => {
    if (isEdit || !blockLibrary) return;
    if (blocks.length > 0) return;
    const rows: BlockRow[] = blockLibrary.blocks.map((b) => ({
      blockId: b.id,
      section: b.section,
      name: b.name,
      description: b.description,
      isSystem: b.isSystem,
      included: b.isSystem,                 // system blocks toggled on by default
      position: b.displayOrder,
    }));
    setBlocks(rows);
  }, [blockLibrary, isEdit, blocks.length]);

  // An edit answers the error the admin is looking at, so the summary goes
  // away rather than pointing at a field that has since changed. Compared by
  // value against the form as it was when the error appeared: state that is
  // re-set to the same content in the background (the block library seeding
  // `blocks` after a load) must not wipe the summary before anyone read it.
  const formSnapshot = JSON.stringify([customerAccountId, title, eventName, eventDate, eventTimeStart,
    eventTimeEnd, introText, outroText, language, issueDate, validUntil, projectId, blocks]);
  const errorFormSnapshotRef = useRef<string | null>(null);
  useEffect(() => {
    if (!saveError) {
      errorFormSnapshotRef.current = null;
      return;
    }
    if (errorFormSnapshotRef.current === null) {
      errorFormSnapshotRef.current = formSnapshot;
      return;
    }
    if (errorFormSnapshotRef.current !== formSnapshot) setSaveError(null);
  }, [saveError, formSnapshot]);

  // Move focus to the summary so keyboard and screen-reader users land on it;
  // role="alert" announces it.
  useEffect(() => {
    if (!saveError || !summaryRef.current) return;
    summaryRef.current.focus();
    summaryRef.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [saveError]);

  const blocksBySection: Record<ContractBlockSection, BlockRow[]> = useMemo(() => {
    const out: Record<ContractBlockSection, BlockRow[]> = {
      basics: [], scope: [], privacy: [], commercial: [], nda: [], closing: [],
    };
    for (const b of blocks) out[b.section]?.push(b);
    for (const k of Object.keys(out) as ContractBlockSection[]) {
      out[k].sort((a, b) => a.position - b.position);
    }
    return out;
  }, [blocks]);

  function toggleBlock(blockId: number) {
    setBlocks((cur) => cur.map((b) => b.blockId === blockId ? { ...b, included: !b.included } : b));
  }

  function moveBlock(blockId: number, delta: -1 | 1) {
    setBlocks((cur) => {
      const idx = cur.findIndex((b) => b.blockId === blockId);
      if (idx < 0) return cur;
      const target = cur[idx];
      const siblings = cur.filter((b) => b.section === target.section).sort((a, b) => a.position - b.position);
      const sib = siblings.findIndex((b) => b.blockId === blockId);
      const next = sib + delta;
      if (next < 0 || next >= siblings.length) return cur;
      const swap = siblings[next];
      return cur.map((b) => {
        if (b.blockId === target.blockId) return { ...b, position: swap.position };
        if (b.blockId === swap.blockId)   return { ...b, position: target.position };
        return b;
      });
    });
  }

  const createMutation = useMutation({
    mutationFn: async (): Promise<number> => {
      if (!customerAccountId) throw new Error('Pick a customer first');
      const fields = {
        language,
        title: title || null,
        eventName: eventName || null,
        eventDate: eventDate || null,
        eventTimeStart: eventTimeStart || null,
        eventTimeEnd: eventTimeEnd || null,
        introText: introText || null,
        outroText: outroText || null,
        issueDate,
        validUntil: validUntil || undefined,
        projectId: projectId ?? null,
        // Sent with the create so the draft and its block selection commit
        // together. A follow-up update could fail after the draft existed,
        // and saving again then created a second one (issue 1447).
        blocks: blocks.map((b) => ({
          blockId: b.blockId, included: b.included, position: b.position,
        })),
      };
      if (replayedDraftIdRef.current === null) {
        const created = await contractsService.create(
          { customerAccountId, ...fields },
          { idempotencyKey: idempotencyKeyRef.current },
        );
        if (!created.replayed) return created.contract.id;
        // A replay is the draft an earlier, unconfirmed attempt stored, as it
        // was then: anything edited since the lost response is not in it.
        // Apply the current form before leaving the editor, and remember the
        // draft so a failure here is retried as an update, not a new create.
        replayedDraftIdRef.current = created.contract.id;
      }
      await contractsService.update(replayedDraftIdRef.current, fields);
      return replayedDraftIdRef.current;
    },
    onSuccess: (createdId) => {
      toast.success(t('contracts.editor.createdToast', 'Contract created.') as string);
      navigate(`/admin/clients/contracts/${createdId}`);
    },
    onError: (err: unknown) => {
      const view = describeSaveError(err);
      // A key another admin already used can never succeed; start a fresh one.
      if (view.code === 'IDEMPOTENCY_KEY_CONFLICT') idempotencyKeyRef.current = newIdempotencyKey();
      setSaveError(view);
    },
    onSettled: () => { submittingRef.current = false; },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!numericId) return;
      await contractsService.update(numericId, {
        title: title || null,
        eventName: eventName || null,
        eventDate: eventDate || null,
        eventTimeStart: eventTimeStart || null,
        eventTimeEnd: eventTimeEnd || null,
        introText: introText || null,
        outroText: outroText || null,
        language,
        issueDate,
        validUntil: validUntil || undefined,
        projectId: projectId ?? null,
        blocks: blocks.map((b) => ({
          blockId: b.blockId, included: b.included, position: b.position,
        })),
      });
    },
    onSuccess: () => {
      toast.success(t('contracts.editor.savedToast', 'Contract saved.') as string);
      navigate(`/admin/clients/contracts/${numericId}`);
    },
    onError: (err: unknown) => { setSaveError(describeSaveError(err)); },
    onSettled: () => { submittingRef.current = false; },
  });

  const isSaving = createMutation.isPending || updateMutation.isPending;

  function handleSave() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSaveError(null);
    if (isEdit) updateMutation.mutate();
    else createMutation.mutate();
  }

  // Localised label + corrective action for a field the server rejected.
  // The server's own message is technical English ("Invalid value"), so it is
  // never shown.
  function fieldProblem(field: string): { label: string; message: string } {
    const tooLong = t('contracts.editor.errors.tooLong', 'Keep it to 255 characters or fewer') as string;
    const invalidDate = t('contracts.editor.errors.invalidDate', 'Enter a valid date') as string;
    const invalidTime = t('contracts.editor.errors.invalidTime', 'Enter a time as HH:MM') as string;
    const invalidText = t('contracts.editor.errors.invalidText', 'Check this text') as string;
    switch (field) {
      case 'customerAccountId':
        return { label: t('contracts.editor.customer', 'Customer') as string, message: t('contracts.editor.errors.customerRequired', 'Pick a customer') as string };
      case 'title':
        return { label: t('contracts.editor.titleField', 'Contract title') as string, message: tooLong };
      case 'eventName':
        return { label: t('contracts.editor.eventName', 'Event name') as string, message: tooLong };
      case 'issueDate':
        return { label: t('contracts.editor.issueDate', 'Issue date') as string, message: invalidDate };
      case 'validUntil':
        return { label: t('contracts.editor.validUntil', 'Sign by (optional)') as string, message: invalidDate };
      case 'eventDate':
        return { label: t('contracts.editor.eventDate', 'Event date') as string, message: invalidDate };
      case 'eventTimeStart':
        return { label: t('contracts.editor.eventTimeStart', 'Start') as string, message: invalidTime };
      case 'eventTimeEnd':
        return { label: t('contracts.editor.eventTimeEnd', 'End') as string, message: invalidTime };
      case 'language':
        return { label: t('contracts.editor.language', 'Language') as string, message: t('contracts.editor.errors.invalidLanguage', 'Pick a language') as string };
      case 'introText':
        return { label: t('contracts.editor.intro', 'Intro text (optional)') as string, message: invalidText };
      case 'outroText':
        return { label: t('contracts.editor.outro', 'Closing text (optional)') as string, message: invalidText };
      case 'blocks':
        return { label: t('contracts.editor.errors.blocksLabel', 'Blocks') as string, message: t('contracts.editor.errors.checkBlocks', 'Check the block selection') as string };
      case 'Idempotency-Key':
        return { label: t('contracts.editor.errors.requestLabel', 'Request') as string, message: t('contracts.editor.errors.reloadAndRetry', 'Reload the page and try again') as string };
      default:
        return { label: field, message: t('contracts.editor.errors.checkValue', 'Check this value') as string };
    }
  }

  function fieldError(field: string): string | undefined {
    if (saveError?.kind !== 'validation' || !saveError.fields.includes(field)) return undefined;
    return fieldProblem(field).message;
  }

  function savedStateSentence(view: SaveErrorView): string {
    // A retry already found the draft an earlier attempt created; what failed
    // is applying the latest edits to it.
    if (!isEdit && replayedDraftIdRef.current !== null) {
      return t('contracts.editor.errors.createdChangesNotSaved', 'The draft was saved, but your latest changes were not. Saving again applies them.') as string;
    }
    if (view.kind === 'unconfirmed') {
      return isEdit
        ? t('contracts.editor.errors.updateUnconfirmed', 'We could not confirm whether your changes were saved. Saving again is safe.') as string
        : t('contracts.editor.errors.createUnconfirmed', 'We could not confirm whether the draft was saved. Saving again is safe — it will not create a second draft.') as string;
    }
    return isEdit
      ? t('contracts.editor.errors.updateNotSaved', 'Your changes were not saved.') as string
      : t('contracts.editor.errors.createNotSaved', 'The draft was not saved.') as string;
  }

  function saveErrorDetail(view: SaveErrorView): React.ReactNode {
    switch (view.kind) {
      case 'validation':
        return (
          <>
            <p className="mt-2">{t('contracts.editor.errors.fieldsHeading', 'Please check the following:')}</p>
            <ul className="list-disc ml-5 mt-1">
              {view.fields.map((field) => {
                const { label, message } = fieldProblem(field);
                return <li key={field}>{`${label}: ${message}`}</li>;
              })}
            </ul>
          </>
        );
      case 'server':
        return <p className="mt-1">{t('contracts.editor.errors.unexpected', 'An unexpected error occurred on the server.')}</p>;
      case 'rejected':
        return (
          <p className="mt-1">
            {view.code === 'PROJECT_CUSTOMER_MISMATCH'
              ? t('projects.error.customerMismatch', 'That project belongs to a different customer than this entry.')
              : (view.message || t('contracts.editor.saveError', 'Save failed'))}
          </p>
        );
      case 'local':
        return <p className="mt-1">{view.message || t('contracts.editor.saveError', 'Save failed')}</p>;
      default:
        return null;
    }
  }

  async function handlePreview() {
    // For new contracts, we'd need to create first to preview; keep it
    // simple — disable preview before save.
    if (!isEdit || !numericId) {
      toast.info(t('contracts.editor.previewAfterSave', 'Save the draft first, then preview.') as string);
      return;
    }
    // Sync-open the placeholder window BEFORE any await so the popup
    // blocker treats this as a user gesture, then redirect once the
    // blob URL is ready. Same pattern bills/quotes use.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.editor.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      const url = await contractsService.previewPdfUrl(numericId);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || t('contracts.editor.previewError', 'Preview failed') as string);
    }
  }

  if (isEdit && existingLoading) return <Loading />;
  if (isEdit && existing && existing.contract.status !== 'draft') {
    return (
      <Card padding="lg">
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {t('contracts.editor.locked', 'Sent contracts cannot be edited. Cancel and create a fresh one for amendments.')}
        </p>
        <div className="mt-3">
          <Link to={`/admin/clients/contracts/${numericId}`} className="text-accent-dark hover:underline">
            ← {t('contracts.editor.backToDetail', 'Back to contract')}
          </Link>
        </div>
      </Card>
    );
  }

  const fieldErrorClass = 'mt-1 text-sm text-red-600 dark:text-red-400';
  const textareaClass = (invalid: boolean) =>
    `w-full px-3 py-2 rounded-md border ${invalid ? 'border-red-500' : 'border-neutral-300 dark:border-neutral-600'} bg-white dark:bg-neutral-800 text-sm`;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link
          to="/admin/clients/contracts"
          className="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-accent-dark"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('contracts.editor.back', 'Back to list')}
        </Link>
        <h1 className="text-2xl font-bold flex-1">
          {isEdit
            ? t('contracts.editor.titleEdit', 'Edit contract')
            : t('contracts.editor.titleNew', 'New contract')}
        </h1>
        {isEdit && (
          <Button variant="outline" onClick={handlePreview}>
            <Eye className="w-4 h-4 mr-1" />
            {t('contracts.editor.preview', 'Preview PDF')}
          </Button>
        )}
        <Button
          onClick={handleSave}
          disabled={isSaving || (!isEdit && !customerAccountId)}
          aria-busy={isSaving}
        >
          <Save className="w-4 h-4 mr-1" />
          {isSaving
            ? t('contracts.editor.saving', 'Saving…')
            : isEdit
              ? t('contracts.editor.save', 'Save')
              : t('contracts.editor.create', 'Create draft')}
        </Button>
      </div>

      {saveError && (
        <div
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
          className="mb-4 p-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 text-sm text-red-900 dark:text-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <p className="font-medium">{savedStateSentence(saveError)}</p>
          {saveErrorDetail(saveError)}
          {saveError.requestId && (
            <p className="mt-2 text-xs">
              {`${t('contracts.editor.errors.referenceId', 'Reference ID')}: ${saveError.requestId}`}
            </p>
          )}
        </div>
      )}

      {/* Scalars */}
      <Card padding="lg" className="mb-4">
        {!isEdit && (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.customer', 'Customer')}
            </label>
            <CustomerPicker
              value={customerAccountId}
              label={customerLabel}
              isPassive={customerIsPassive}
              onSelect={(c) => {
                setCustomerAccountId(c.id);
                setCustomerLabel(
                  c.companyName
                  || [c.firstName, c.lastName].filter(Boolean).join(' ')
                  || c.displayName
                  || c.email
                  || `#${c.id}`,
                );
                setCustomerIsPassive(Boolean(c.isPassive));
              }}
              onCreate={(c) => {
                setCustomerAccountId(c.id);
                setCustomerLabel(
                  c.companyName
                  || [c.firstName, c.lastName].filter(Boolean).join(' ')
                  || c.displayName
                  || c.email
                  || `#${c.id}`,
                );
                setCustomerIsPassive(Boolean(c.isPassive));
              }}
              onClear={() => { setCustomerAccountId(null); setCustomerLabel(''); setCustomerIsPassive(false); }}
              searchPlaceholder={t('contracts.editor.searchCustomer', 'Search by email…') as string}
            />
            {fieldError('customerAccountId') && (
              <p className={fieldErrorClass}>{fieldError('customerAccountId')}</p>
            )}
          </div>
        )}

        {/* Project link (renders only when the projects feature is on). */}
        <div className="mb-4">
          <ProjectSelect
            label={t('projects.picker.label', 'Project') as string}
            value={projectId}
            customerAccountId={customerAccountId}
            onChange={setProjectId}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.titleField', 'Contract title')}
            </label>
            <Input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('contracts.editor.titlePlaceholder', 'e.g. Wedding contract Doe / Müller') as string}
              error={fieldError('title')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.language', 'Language')}
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-invalid={fieldError('language') ? 'true' : undefined}
              aria-describedby={fieldError('language') ? 'contract-language-error' : undefined}
              className={textareaClass(Boolean(fieldError('language')))}
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
            {fieldError('language') && (
              <p id="contract-language-error" className={fieldErrorClass}>{fieldError('language')}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.issueDate', 'Issue date')}
            </label>
            <LocalizedDateInput value={issueDate} onChange={setIssueDate} error={fieldError('issueDate')} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('contracts.editor.validUntil', 'Sign by (optional)')}
            </label>
            <LocalizedDateInput value={validUntil} onChange={setValidUntil} error={fieldError('validUntil')} />
          </div>
        </div>

        {/* Event snapshot fields. Match the quote editor so the chain
            quote → contract → invoice carries the same labels. When
            createFromQuote drafts a contract from an accepted quote
            these come prefilled from the quote. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h3 className="text-sm font-semibold mb-2">
            {t('contracts.editor.eventSection', 'Event (optional)')}
          </h3>
          <p className="text-xs text-neutral-500 mb-3">
            {t('contracts.editor.eventHelp',
              'Snapshotted onto the contract and propagated to any event / invoice generated from it. Set this so the customer portal and dunning emails show the right "Wedding Doe / Müller" label.')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium mb-1">
                {t('contracts.editor.eventName', 'Event name')}
              </label>
              <Input
                type="text"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder={t('contracts.editor.eventNamePlaceholder',
                  'e.g. Wedding Doe / Müller') as string}
                error={fieldError('eventName')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('contracts.editor.eventDate', 'Event date')}
              </label>
              <LocalizedDateInput value={eventDate} onChange={setEventDate} error={fieldError('eventDate')} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('contracts.editor.eventTimeStart', 'Start')}
                </label>
                <TimeField value={eventTimeStart} onChange={setEventTimeStart} />
                {fieldError('eventTimeStart') && (
                  <p className={fieldErrorClass}>{fieldError('eventTimeStart')}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('contracts.editor.eventTimeEnd', 'End')}
                </label>
                <TimeField value={eventTimeEnd} onChange={setEventTimeEnd} />
                {fieldError('eventTimeEnd') && (
                  <p className={fieldErrorClass}>{fieldError('eventTimeEnd')}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3">
          <label className="block text-sm font-medium mb-1">
            {t('contracts.editor.intro', 'Intro text (optional)')}
          </label>
          <textarea
            value={introText}
            onChange={(e) => setIntroText(e.target.value)}
            rows={3}
            aria-invalid={fieldError('introText') ? 'true' : undefined}
            aria-describedby={fieldError('introText') ? 'contract-intro-error' : undefined}
            className={textareaClass(Boolean(fieldError('introText')))}
          />
          {fieldError('introText') && (
            <p id="contract-intro-error" className={fieldErrorClass}>{fieldError('introText')}</p>
          )}
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium mb-1">
            {t('contracts.editor.outro', 'Closing text (optional)')}
          </label>
          <textarea
            value={outroText}
            onChange={(e) => setOutroText(e.target.value)}
            rows={2}
            aria-invalid={fieldError('outroText') ? 'true' : undefined}
            aria-describedby={fieldError('outroText') ? 'contract-outro-error' : undefined}
            className={textareaClass(Boolean(fieldError('outroText')))}
          />
          {fieldError('outroText') && (
            <p id="contract-outro-error" className={fieldErrorClass}>{fieldError('outroText')}</p>
          )}
        </div>
      </Card>

      {/* Disclaimer banner */}
      <div className="mb-4 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200">
        <p className="font-medium mb-1">
          {t('contracts.editor.disclaimerTitle', 'Legal review recommended')}
        </p>
        <p className="text-xs">
          {t('contracts.editor.disclaimerBody', 'The seeded block texts are examples written by the maintainer, not by a lawyer. Before you send a contract, have the blocks you include reviewed for your jurisdiction and use case — you remain responsible for its content. This does not stop you saving a draft.')}
          {' '}
          <a
            href={CRM_DISCLAIMER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium"
          >
            {t('contracts.editor.disclaimerLink', 'Read the CRM disclaimer')}
          </a>
        </p>
        <p className="text-xs mt-2 pt-2 border-t border-amber-200/60 dark:border-amber-800/60">
          {t('contracts.editor.schriftformWarning',
            'Signature type: simple electronic signature (SES). Sufficient for routine photography contracts in CH / DE / AT / FL. NOT sufficient for documents that legally require Schriftform / form qualifiée: Bürgschaft (DE § 766 BGB), Verbraucherdarlehensvertrag (DE § 492 BGB), befristete Arbeitsverträge (DE § 14 Abs. 4 TzBfG), and similar. For those, a qualified electronic signature (QES) from a Trust Service Provider is required — picpeak does not provide QES.')}
        </p>
      </div>

      {fieldError('blocks') && (
        <p className={`${fieldErrorClass} mb-3`}>{fieldError('blocks')}</p>
      )}

      {/* Block accordions */}
      {CONTRACT_SECTIONS.map((section) => (
        <Card key={section} padding="lg" className="mb-3">
          <h2 className="text-lg font-semibold mb-2">
            {t(`contracts.sections.${section}`, section)}
          </h2>
          {blocksBySection[section].length === 0 ? (
            <p className="text-sm text-neutral-500">
              {t('contracts.editor.noBlocksInSection', 'No blocks for this section yet.')}
            </p>
          ) : (
            <ul className="space-y-2">
              {blocksBySection[section].map((b) => (
                <li
                  key={b.blockId}
                  className="flex items-start gap-3 p-2 rounded border border-neutral-200 dark:border-neutral-700"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={b.included}
                    onChange={() => toggleBlock(b.blockId)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{b.name}</span>
                      {b.isSystem && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700">
                          {t('contracts.editor.systemBadge', 'System')}
                        </span>
                      )}
                    </div>
                    {b.description && (
                      <p className="text-xs text-neutral-500 mt-1">{b.description}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      className="px-2 py-0.5 text-xs rounded border border-neutral-300 dark:border-neutral-600"
                      onClick={() => moveBlock(b.blockId, -1)}
                    >↑</button>
                    <button
                      type="button"
                      className="px-2 py-0.5 text-xs rounded border border-neutral-300 dark:border-neutral-600"
                      onClick={() => moveBlock(b.blockId, 1)}
                    >↓</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
};
