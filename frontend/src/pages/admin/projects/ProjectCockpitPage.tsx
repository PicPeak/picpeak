/**
 * Admin → Project page: one job from inquiry to final invoice.
 *
 * Header (UX.md › Page anatomy): the name with a pen, the status pill, the
 * `⋯` menu, then the primary action of the moment, which is the next step
 * of the project's stage (projectSteps.ts). Three tabs, kept in `?tab=`:
 *   - Overview: the stages, the documents grouped by stage, and in the
 *     right column the project's data and customer as fields that are
 *     always open. They change one page-level draft that saves through the
 *     save bar (only changed fields are sent; a refetch keeps the admin's
 *     edits). This deliberately departs from "nothing on Overview needs
 *     saving": a project's data is the project, not configuration.
 *   - Activity: the dated feed of every email and document (unchanged).
 *   - Settings: status (cancel, complete, reopen) and the Danger zone.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Ban, Calendar, MapPin, Paperclip, Pencil, RotateCcw, User } from 'lucide-react';
import {
  ActionMenu, Badge, Button, ErrorState, Loading, Tabs, usePrompt,
  type ActionMenuItem, type BadgeTone, type TabItem,
} from '../../../components/common';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import { useLeaveGuard } from '../../../contexts/UnsavedChangesContext';
import { CustomerGroupChipList } from '../../../components/admin/CustomerGroupChips';
import { ConvertToContractDialog } from '../quotes/ConvertToContractDialog';
import { projectsService, type ProjectOverview, type ProjectStageKey, type ProjectStatus } from '../../../services/projects.service';
import { businessProfileService } from '../../../services/businessProfile.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../../hooks';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../../contexts/PermissionsContext';
import { ProjectActivityFeed, minutesToHours } from './ProjectActivityFeed';
import { ProjectStageCard } from './ProjectStageCard';
import { ProjectDocumentsCard } from './ProjectDocumentsCard';
import { AttachDocumentDialog, type AttachKind } from './AttachDocumentDialog';
import { ProjectCustomerCard, ProjectDataCard, ProjectValueCard, type CustomerChoice } from './ProjectSideCards';
import { ProjectSettingsTab } from './ProjectSettingsTab';
import { projectSteps, type ProjectStep } from './projectSteps';
import { BriefCard, useBriefEditor } from '../../../features/briefs/BriefCard';
import { StepIcon, useRunStep, useStepLabel } from './useProjectSteps';
import {
  MAX_GUESTS, changedKeys, draftError, draftFromProject, rebaseDraft, updatePayload, type ProjectDraft,
} from './projectDraft';

type ProjectTab = 'overview' | 'activity' | 'settings';
const TABS: ProjectTab[] = ['overview', 'activity', 'settings'];
const isTab = (v: string | null): v is ProjectTab => !!v && (TABS as string[]).includes(v);

export const STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  inquiry: 'info', active: 'success', completed: 'neutral', cancelled: 'danger', archived: 'neutral',
};

const customerFromProject = (data: ProjectOverview): CustomerChoice => ({
  id: data.project.customerAccountId,
  label: data.project.customerEmail || '',
  isPassive: false,
});

export const ProjectCockpitPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const projectId = id ? parseInt(id, 10) : null;
  const { t } = useTranslation();

  const { data, isLoading, isError, refetch } = useQuery<ProjectOverview>({
    queryKey: ['project-overview', projectId],
    queryFn: () => projectsService.overview(projectId as number),
    enabled: projectId !== null,
  });

  if (isLoading) return <Loading />;
  // A failed first load is an error, not "not found" (UX.md › States). A
  // failed background refetch keeps the loaded page.
  if (!data) {
    return isError
      ? <ErrorState title={t('projects.loadOneFailed', 'Could not load the project.')} onRetry={() => refetch()} />
      : <div className="p-6 text-muted">{t('projects.notFound', 'Project not found')}</div>;
  }
  return <ProjectPage data={data} />;
};

const ProjectPage: React.FC<{ data: ProjectOverview }> = ({ data }) => {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { flags } = useFeatureFlags();
  const { hasPermission } = usePermissions();
  const { format } = useLocalizedDate();
  const [promptDialog, prompt] = usePrompt();
  const { unguarded } = useLeaveGuard();
  const [searchParams, setSearchParams] = useSearchParams();
  const project = data.project;
  const projectId = project.id;

  // Projects write with events.edit (adminProjects.js); linking a customer
  // also needs customers.view.
  const canEdit = hasPermission('events.edit');
  const canViewCustomers = hasPermission('customers.view');

  // ── Tabs, in ?tab= (read on mount, kept in step with back/forward) ──
  const [tab, setTab] = useState<ProjectTab>(isTab(searchParams.get('tab')) ? (searchParams.get('tab') as ProjectTab) : 'overview');
  // Which kind of existing document the search window adds, if open.
  const [adding, setAdding] = useState<AttachKind | null>(null);
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    const urlTab = searchParams.get('tab');
    if (isTab(urlTab) && urlTab !== tab) setTab(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── The page draft: project data + customer ──
  const base = useMemo(() => draftFromProject(project), [project]);
  const [draft, setDraft] = useState<ProjectDraft>(base);
  const baseRef = useRef(base);
  useEffect(() => {
    // A refetch changed the saved state: keep the admin's edits, take the rest.
    setDraft((d) => rebaseDraft(d, baseRef.current, base));
    baseRef.current = base;
  }, [base]);
  const savedCustomer = useMemo(() => customerFromProject(data), [data]);
  const [customer, setCustomer] = useState<CustomerChoice>(savedCustomer);
  const savedCustomerRef = useRef(savedCustomer);
  useEffect(() => {
    setCustomer((c) => (c.id === savedCustomerRef.current.id ? savedCustomer : c));
    savedCustomerRef.current = savedCustomer;
  }, [savedCustomer]);

  // The brief (issue 2678) is the project's data too: one save bar for both.
  const brief = useBriefEditor({ kind: 'projects', id: projectId });

  const dirtyKeys = changedKeys(draft, base);
  const customerDirty = customer.id !== savedCustomer.id;
  const projectDirty = dirtyKeys.length > 0 || customerDirty;
  const isDirty = projectDirty || brief.dirty;
  const discard = () => { setDraft(base); setCustomer(savedCustomer); brief.discard(); };

  // A budget is stored with its currency: the business profile's when the
  // admin did not pick one (as on New inquiry).
  // GET /admin/business-profile needs settings.view or settings.banking; without
  // it there is no default to offer, and none is guessed.
  const canReadProfile = hasPermission('settings.view') || hasPermission('settings.banking');
  const { data: profileSnap } = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => businessProfileService.get(),
    enabled: canReadProfile,
    retry: false,
  });
  const defaultCurrency = profileSnap?.profile.defaultCurrency || undefined;
  const save = useMutationWithToast({
    mutationFn: () => {
      const payload = updatePayload(draft, base);
      if (payload.budgetMinor != null && !draft.currency && defaultCurrency) payload.currency = defaultCurrency;
      return projectsService.update(projectId, {
        ...payload,
        ...(customerDirty ? { customerAccountId: customer.id } : {}),
      });
    },
    successMessage: t('projects.toast.saved', 'Project saved') as string,
    errorMessage: (err: unknown) => {
      const res = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      if (res?.code === 'PROJECT_CUSTOMER_MISMATCH') return t('projects.error.customerMismatch', 'That belongs to a different customer than this project.') as string;
      return res?.error || (t('projects.toast.saveFailed', 'Save failed') as string);
    },
    // The brief shows the project's date, location and guest count.
    invalidateKeys: [['project-overview', projectId], ['projects'], ['brief', 'projects', projectId]],
  });
  // Each changed slice saves on its own; a failed one stays dirty (UX.md › Saving).
  // The brief goes first: the server checks its values against the project's
  // occasion as saved, which the project data may be about to change.
  const saveAll = async () => {
    const saved = (job: () => Promise<unknown>) => job().then(() => true, () => false);
    const briefSaved = brief.dirty ? await saved(() => brief.save.mutateAsync()) : true;
    // A new occasion would void the brief edits that just failed: the project
    // data then waits as well, both stay unsaved, and the brief's error said why.
    if (!briefSaved && dirtyKeys.includes('eventType')) throw new Error('Save failed');
    const projectSaved = projectDirty ? await saved(() => save.mutateAsync()) : true;
    if (!briefSaved || !projectSaved) throw new Error('Save failed');
  };
  const isSaving = save.isPending || brief.save.isPending;

  const rename = useMutationWithToast({
    mutationFn: (name: string) => projectsService.update(projectId, { name }),
    successMessage: t('projects.toast.renamed', 'Project renamed') as string,
    errorMessage: t('projects.toast.saveFailed', 'Save failed') as string,
    invalidateKeys: [['project-overview', projectId], ['projects']],
  });
  const onRename = async () => {
    const name = await prompt({
      title: t('projects.rename', 'Rename'),
      label: t('projects.renameLabel', 'Project name'),
      defaultValue: project.name,
      confirmLabel: t('projects.rename', 'Rename'),
    });
    if (name && name.trim() && name.trim() !== project.name) rename.mutate(name.trim());
  };

  const setStatus = useMutationWithToast({
    mutationFn: (status: ProjectStatus | 'reopen') => projectsService.update(projectId, { status }),
    successMessage: (_r, status) => (status === 'cancelled'
      ? t('projects.toast.cancelled', 'Project marked as cancelled.')
      : t('projects.toast.reopened', 'Project reopened.')) as string,
    errorMessage: t('projects.toast.saveFailed', 'Save failed') as string,
    invalidateKeys: [['project-overview', projectId], ['projects']],
  });

  // Skipping a stage is an action, like cancel and complete: saved at once,
  // outside the save bar, and undone from the stage itself.
  const skipStage = useMutationWithToast({
    mutationFn: ({ stage, skip }: { stage: ProjectStageKey; skip: boolean }) => {
      const current = new Set(project.skippedStages || []);
      if (skip) current.add(stage); else current.delete(stage);
      return projectsService.update(projectId, { skippedStages: Array.from(current) });
    },
    successMessage: (_r, { skip }) => (skip
      ? t('projects.toast.stageSkipped', 'Step skipped.')
      : t('projects.toast.stageRestored', 'Step taken back into the project.')) as string,
    errorMessage: t('projects.toast.saveFailed', 'Save failed') as string,
    invalidateKeys: [['project-overview', projectId], ['projects']],
  });

  // ── The next step ──
  const stepLabel = useStepLabel();
  const { run, isRunning } = useRunStep(projectId);
  const { main, later } = projectSteps(data, { flags, can: hasPermission });
  const [contractFrom, setContractFrom] = useState<ProjectStep | null>(null);
  // A step's editor starts from the saved project, so unsaved edits (a new
  // date) are saved first rather than lost behind a leave prompt.
  // Why the draft cannot be saved, said where the field is (UX.md: validate
  // on Save and jump to the section).
  const blockedText = (blocked: 'endBeforeStart' | 'tooManyGuests') => (blocked === 'endBeforeStart'
    ? t('projects.field.endBeforeStart', 'The end date is before the start date.')
    : t('projects.field.tooManyGuests', 'At most {{max}} guests.', { max: MAX_GUESTS.toLocaleString(i18n.language) })) as string;
  const runStep = async (step: ProjectStep) => {
    if (isDirty) {
      const blocked = draftError(draft);
      if (blocked) {
        setTab('overview');
        toast.error(blockedText(blocked));
        return;
      }
      try { await saveAll(); } catch { return; }
      // The page still holds the pre-save state until the refetch renders;
      // what was unsaved is saved now, so leaving needs no question.
      await qc.refetchQueries({ queryKey: ['project-overview', projectId] });
      if (step.kind === 'createContract') { setContractFrom(step); return; }
      unguarded(() => run(step));
      return;
    }
    if (step.kind === 'createContract') { setContractFrom(step); return; }
    run(step);
  };
  const sourceQuote = contractFrom ? data.quotes.find((q) => q.id === contractFrom.sourceId) : null;

  const closed = project.status === 'cancelled' || project.status === 'completed';
  // Adding an existing quote or contract runs the CRM write rule: only on a
  // project new documents may join (documentsLinkable), with the route's permission.
  const canLink = canEdit && !closed && project.documentsLinkable !== false;
  const menuItems: ActionMenuItem[] = [];
  if (canEdit && !closed) {
    menuItems.push({
      key: 'attach',
      label: t('projects.menu.attach', 'Attach a gallery'),
      icon: <Paperclip className="w-4 h-4" />,
      onSelect: () => { setTab('overview'); setAdding('gallery'); },
    });
    menuItems.push({
      key: 'cancel',
      label: t('projects.settings.cancel', 'Mark as cancelled'),
      icon: <Ban className="w-4 h-4" />,
      onSelect: () => setStatus.mutate('cancelled'),
    });
  }
  if (canEdit && closed) {
    menuItems.push({
      key: 'reopen',
      label: t('projects.settings.reopen', 'Reopen'),
      icon: <RotateCcw className="w-4 h-4" />,
      onSelect: () => setStatus.mutate('reopen'),
    });
  }

  // What the quotes offered, per currency (the newest accepted one wins).
  const quotedMinor = useMemo(() => {
    const out: Record<string, number> = {};
    for (const q of data.quotes) {
      if ((q.status === 'accepted' || q.status === 'converted') && out[q.currency] == null) out[q.currency] = Number(q.total_amount_minor);
    }
    return out;
  }, [data.quotes]);

  const statusWord = t(`projects.status.${project.status}`, project.status);
  const tabs: TabItem<ProjectTab>[] = [
    { id: 'overview', label: t('projects.tabs.overview', 'Overview'), dirty: isDirty, dirtyLabel: t('settings.saveBar.unsaved', 'You have unsaved changes') as string },
    { id: 'activity', label: t('projects.tabs.activity', 'Activity'), count: data.emails.length + data.hours.entries.length },
    { id: 'settings', label: t('projects.tabs.settings', 'Settings') },
  ];

  return (
    <div>
      {promptDialog}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 w-full sm:w-auto">
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 text-2xl font-bold text-heading break-words">{project.name}</h1>
            {canEdit && (
              <button
                type="button"
                onClick={onRename}
                className="mt-1 p-1 rounded-lg text-soft hover:text-heading hover:bg-hover shrink-0"
                aria-label={t('projects.rename', 'Rename') as string}
                title={t('projects.rename', 'Rename') as string}
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
            <span className="mt-1.5 shrink-0"><Badge tone={STATUS_TONE[project.status] ?? 'neutral'}>{statusWord}</Badge></span>
            {menuItems.length > 0 && (
              <ActionMenu items={menuItems} align="right" size="icon-sm" label={t('projects.menu.more', 'More actions') as string} className="ml-auto shrink-0 sm:hidden" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-soft">
            {project.customerEmail && (
              <span className="inline-flex items-center gap-1"><User className="w-4 h-4" />{project.customerEmail}</span>
            )}
            {project.customerGroups && project.customerGroups.length > 0 && (
              <CustomerGroupChipList groups={project.customerGroups} max={2} />
            )}
            {project.eventDate && (
              <span className="inline-flex items-center gap-1"><Calendar className="w-4 h-4" />{format(project.eventDate)}</span>
            )}
            {project.location && (
              <span className="inline-flex items-center gap-1"><MapPin className="w-4 h-4" />{project.location}</span>
            )}
            {data.hours.totalMinutes > 0 && (
              <span>{t('projects.totalHours', '{{hours}} logged', { hours: minutesToHours(data.hours.totalMinutes) })}</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {menuItems.length > 0 && (
            <ActionMenu items={menuItems} align="right" size="icon-sm" label={t('projects.menu.more', 'More actions') as string} className="hidden sm:block" />
          )}
          {main && (
            <Button variant="primary" size="sm" leftIcon={<StepIcon kind={main.kind} />} isLoading={isRunning || isSaving} onClick={() => { void runStep(main); }}>
              {stepLabel(main.kind)}
            </Button>
          )}
        </div>
      </div>

      <Tabs items={tabs} value={tab} onChange={setTab} className="mb-6" />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
          <div className="space-y-6 min-w-0">
            <ProjectStageCard
              data={data}
              main={main}
              later={later}
              onRun={(step) => { void runStep(step); }}
              busy={isRunning || isSaving || skipStage.isPending}
              onSkip={canEdit && !closed ? (stage) => skipStage.mutate({ stage, skip: true }) : undefined}
              onRestore={canEdit && !closed ? (stage) => skipStage.mutate({ stage, skip: false }) : undefined}
            />
            <ProjectDocumentsCard
              data={data}
              flags={flags}
              can={hasPermission}
              canAttachGallery={canEdit && !closed}
              canAttachQuote={canLink && !!flags.quotes && hasPermission('quotes.manage')}
              canAttachContract={canLink && !!flags.contracts && hasPermission('contracts.manage')}
              canAttachInvoice={canLink && !!flags.bills && hasPermission('bills.manage')}
              onAdd={setAdding}
            />
            <AttachDocumentDialog kind={adding} data={data} onClose={() => setAdding(null)} />
            <BriefCard editor={brief} canEdit={canEdit} pageBusy={projectDirty || isSaving} />
          </div>
          <div className="space-y-6 min-w-0">
            <ProjectValueCard valuation={data.valuation} quotedMinor={quotedMinor} />
            <ProjectDataCard
              draft={draft}
              onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
              dirty={dirtyKeys}
              canEdit={canEdit}
              defaultCurrency={defaultCurrency}
            />
            <ProjectCustomerCard
              customer={customer}
              savedCustomerId={savedCustomer.id}
              onChange={setCustomer}
              dirty={customerDirty}
              canChange={canEdit && canViewCustomers}
              canViewCustomers={canViewCustomers}
              canInvite={hasPermission('customers.create')}
            />
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <ProjectActivityFeed data={data} flags={flags} canSendEmail={hasPermission('email.send')} />
      )}

      {tab === 'settings' && <ProjectSettingsTab data={data} canEdit={canEdit} />}

      {canEdit && (
        <SettingsSaveBar
          isDirty={isDirty}
          isSaving={isSaving}
          onSave={() => {
            const blocked = draftError(draft);
            if (blocked) {
              setTab('overview');
              toast.error(blockedText(blocked));
              return;
            }
            saveAll().catch(() => { /* the failed slice toasted and stays dirty */ });
          }}
          onDiscard={discard}
        />
      )}

      {contractFrom && (
        <ConvertToContractDialog
          sourceTemplateId={sourceQuote?.source_template_id}
          converting={isRunning}
          onClose={() => setContractFrom(null)}
          onConvert={(templateId) => {
            run(contractFrom, templateId);
            setContractFrom(null);
            qc.invalidateQueries({ queryKey: ['project-overview', projectId] });
          }}
        />
      )}
    </div>
  );
};
