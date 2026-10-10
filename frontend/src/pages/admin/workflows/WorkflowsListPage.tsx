/**
 * Admin → Workflows list. Shows every automation flow with its trigger and
 * enabled state, a quick enable toggle, edit (canvas) and delete. "New
 * workflow" mints a minimal trigger→action graph and opens the editor. A
 * pending-approvals shortcut sits in the header.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Workflow as WorkflowIcon, Inbox, Trash2, Pencil, FlaskConical } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Modal, useConfirm } from '../../../components/common';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';
import { useMutationWithToast } from '../../../hooks';
import { usePermissions } from '../../../contexts/PermissionsContext';
import { workflowsService, type WorkflowSummary, type WorkflowSavePayload, type WorkflowTestResult } from '../../../services/workflows.service';

const NEW_WORKFLOW: WorkflowSavePayload = {
  name: 'New workflow',
  trigger_type: 'invoice.sent',
  enabled: false,
  nodes: [
    { node_key: 'trigger', type: 'trigger', pos_x: 240, pos_y: 40 },
    { node_key: 'step1', type: 'action', config: { action: 'noop' }, pos_x: 240, pos_y: 200 },
  ],
  edges: [{ from_node: 'trigger', to_node: 'step1' }],
};

export const WorkflowsListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  // The server only lets a super admin delete a workflow (it takes every
  // owner's run history with it), so nobody else is offered the button.
  const { isSuperAdmin } = usePermissions();

  const { data: workflows, isLoading, isError, isRefetching, refetch } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => workflowsService.list(),
  });

  const createMutation = useMutation({
    mutationFn: () => workflowsService.create(NEW_WORKFLOW),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/admin/automation/workflows/${res.id}`);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('workflows.toast.createFailed', 'Could not create workflow') as string)),
  });

  const [testTarget, setTestTarget] = useState<WorkflowSummary | null>(null);
  const [testEntityId, setTestEntityId] = useState('');
  const [testResult, setTestResult] = useState<WorkflowTestResult | null>(null);
  const testMutation = useMutation({
    mutationFn: () => workflowsService.testRun(testTarget!.id, {
      entityId: testEntityId ? Number(testEntityId) : null,
      dryRun: true,
    }),
    onSuccess: (res) => setTestResult(res),
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('workflows.test.failed', 'Test run failed') as string)),
  });

  const toggleMutation = useMutationWithToast({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => workflowsService.setEnabled(id, enabled),
    invalidateKeys: [['workflows']],
    errorMessage: t('common.error', 'Something went wrong') as string,
  });

  const deleteMutation = useMutationWithToast({
    mutationFn: (id: number) => workflowsService.remove(id),
    successMessage: t('workflows.toast.deleted', 'Workflow deleted') as string,
    invalidateKeys: [['workflows']],
    errorMessage: t('workflows.toast.deleteFailed', 'Could not delete workflow') as string,
  });

  const isEnabled = (w: WorkflowSummary) => w.enabled === true || w.enabled === 1;
  const isBuiltin = (w: WorkflowSummary) => w.is_builtin === true || w.is_builtin === 1;

  // Disabling a built-in reverts to the legacy hardcoded behaviour (it does NOT
  // stop the automation) — warn so the admin isn't surprised. Enabling is guarded
  // server-side (a flow using unimplemented actions is refused with a clear error).
  const toggle = async (w: WorkflowSummary) => {
    const next = !isEnabled(w);
    if (!next && isBuiltin(w)) {
      const ok = await confirm({
        title: t('workflows.toggle.disableBuiltinTitle', 'Disable this built-in workflow?'),
        message: t('workflows.toggle.confirmDisableBuiltin',
          'Disabling this built-in reverts to the previous built-in behaviour — it does not turn the automation off. Continue?') as string,
        variant: 'warning',
        confirmLabel: t('workflows.toggle.disableBuiltin', 'Disable workflow'),
      });
      if (!ok) return;
    }
    toggleMutation.mutate({ id: w.id, enabled: next });
  };

  const remove = async (w: WorkflowSummary) => {
    const ok = await confirm({
      title: t('workflows.confirmDelete', 'Delete this workflow?') as string,
      message: t('workflows.confirmDeleteNamed', 'Delete "{{name}}"? Runs in progress stop and the flow cannot be restored.', { name: w.name }),
      variant: 'danger',
      confirmLabel: t('workflows.deleteAction', 'Delete workflow'),
    });
    if (ok) deleteMutation.mutate(w.id);
  };

  const createButton = (
    <Button variant="primary" isLoading={createMutation.isPending} onClick={() => createMutation.mutate()} leftIcon={<Plus className="w-4 h-4" />}>
      {t('workflows.new', 'New workflow')}
    </Button>
  );

  return (
    <div className="space-y-6">
      <SectionPageHeader
        icon={WorkflowIcon}
        title={t('workflows.title', 'Workflows')}
        description={t('workflows.subtitle', 'Visual automations — triggers, conditions, gates and actions.')}
        feature="workflows"
        className=""
        actions={(
          <>
            <Button variant="outline" onClick={() => navigate('/admin/automation/approvals')} leftIcon={<Inbox className="w-4 h-4" />}>
              {t('workflows.approvals.title', 'Approvals')}
            </Button>
            {createButton}
          </>
        )}
      />

      <Card padding="none">
        {isLoading ? (
          <div className="p-10"><Loading /></div>
        ) : isError && !workflows ? (
          <ErrorState
            size="inline"
            title={t('workflows.loadFailed', 'Could not load the workflows')}
            onRetry={() => refetch()}
            retrying={isRefetching}
          />
        ) : !workflows || workflows.length === 0 ? (
          <EmptyState
            size="inline"
            icon={<WorkflowIcon />}
            title={t('workflows.emptyTitle', 'No workflows yet')}
            description={t('workflows.empty', 'Create one to automate your invoicing and booking steps.')}
            action={createButton}
          />
        ) : (
          <ul className="divide-y divide-line">
            {workflows.map((w) => (
              <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link to={`/admin/automation/workflows/${w.id}`} className="font-medium text-heading truncate hover:underline">{w.name}</Link>
                    {isBuiltin(w) && (
                      <Badge>{t('workflows.builtin', 'built-in')}</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {t('workflows.triggerLabel', 'Trigger')}: <code>{w.trigger_type}</code> · v{w.version}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(w)}
                  aria-pressed={isEnabled(w)}
                  className={`text-xs px-2 py-1 rounded-full border ${isEnabled(w)
                    ? 'bg-success-soft text-success-text border-success-line'
                    : 'bg-subtle text-muted border-line-strong'}`}
                >
                  {isEnabled(w) ? t('workflows.enabled', 'Enabled') : t('workflows.disabled', 'Disabled')}
                </button>
                <Button variant="ghost" size="sm" onClick={() => { setTestResult(null); setTestEntityId(''); setTestTarget(w); }} aria-label={t('workflows.test.title', 'Test run') as string}>
                  <FlaskConical className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => navigate(`/admin/automation/workflows/${w.id}`)} aria-label={t('common.edit', 'Edit') as string}>
                  <Pencil className="w-4 h-4" />
                </Button>
                {isSuperAdmin && !isBuiltin(w) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(w)}
                    aria-label={t('common.delete', 'Delete') as string}
                  >
                    <Trash2 className="w-4 h-4 text-danger-text" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={!!testTarget}
        onClose={() => setTestTarget(null)}
        title={testTarget ? `${t('workflows.test.title', 'Test run')} — ${testTarget.name}` : ''}
        description={t('workflows.test.hint', 'Dry run: walks the whole flow now (waits skipped, gates auto-confirmed) with side effects mocked — no real emails. Optionally give an entity id (e.g. an invoice) so conditions can read it.')}
        size="lg"
        footer={(
          <Button variant="primary" isLoading={testMutation.isPending} onClick={() => testMutation.mutate()}>
            {t('workflows.test.run', 'Run dry test')}
          </Button>
        )}
      >
        <div className="space-y-3">
          <input
            value={testEntityId} onChange={(e) => setTestEntityId(e.target.value)}
            placeholder={t('workflows.test.entityId', 'Entity id (optional, e.g. invoice id)') as string}
            aria-label={t('workflows.test.entityId', 'Entity id (optional, e.g. invoice id)') as string}
            className="w-full px-3 py-2 rounded-lg border border-line-strong bg-panel text-heading text-sm"
          />
          {testResult && (
            <div className="mt-2">
              <div className="text-sm mb-1 text-body">
                {t('workflows.test.result', 'Result')}: <span className="font-medium">{testResult.status}</span>
              </div>
              <ol className="text-xs space-y-1">
                {testResult.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 border-b border-line-faint pb-1">
                    <span className="text-faint w-6 shrink-0">{i + 1}.</span>
                    <span className="font-mono text-body">{s.node_type}:{s.node_key}</span>
                    <span className="text-muted">{s.status}</span>
                    {s.result && (s.result as any).would ? <span className="text-info-text">→ would {String((s.result as any).would)}</span> : null}
                    {s.error ? <span className="text-danger-text">{s.error}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};
