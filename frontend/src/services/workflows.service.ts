import { api } from '../config/api';

export type WorkflowNodeType =
  | 'trigger' | 'condition' | 'branch' | 'loop' | 'wait' | 'action' | 'gate' | 'webhook';

export interface WorkflowNode {
  id?: number;
  node_key: string;
  type: WorkflowNodeType;
  config?: Record<string, unknown>;
  pos_x?: number;
  pos_y?: number;
}

export interface WorkflowEdge {
  id?: number;
  from_node: string;
  from_handle?: string | null;
  to_node: string;
  label?: string | null;
  loop_back?: boolean;
}

export interface WorkflowSummary {
  id: number;
  name: string;
  description?: string | null;
  enabled: boolean | number;
  version: number;
  trigger_type: string;
  is_builtin?: boolean | number;
  builtin_key?: string | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  trigger_config?: Record<string, unknown> | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowRun {
  id: number;
  workflow_id: number;
  version: number;
  trigger_event: string;
  entity_type?: string | null;
  entity_id?: number | null;
  status: string;
  current_node?: string | null;
  started_at?: string;
  finished_at?: string | null;
  error?: string | null;
}

export interface WorkflowApproval {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
  expires_at?: string | null;
  run_id: number;
  entity_type?: string | null;
  entity_id?: number | null;
  workflow_id: number;
  workflow_name: string;
}

export interface WorkflowSavePayload {
  name: string;
  description?: string | null;
  enabled?: boolean;
  trigger_type: string;
  trigger_config?: Record<string, unknown> | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export const workflowsService = {
  list: async (): Promise<WorkflowSummary[]> => (await api.get<WorkflowSummary[]>('/admin/workflows')).data,
  get: async (id: number): Promise<WorkflowDetail> => (await api.get<WorkflowDetail>(`/admin/workflows/${id}`)).data,
  create: async (payload: WorkflowSavePayload): Promise<{ id: number }> =>
    (await api.post<{ id: number }>('/admin/workflows', payload)).data,
  update: async (id: number, payload: WorkflowSavePayload): Promise<{ id: number; version: number }> =>
    (await api.put<{ id: number; version: number }>(`/admin/workflows/${id}`, payload)).data,
  setEnabled: async (id: number, enabled: boolean) =>
    (await api.patch(`/admin/workflows/${id}/enabled`, { enabled })).data,
  remove: async (id: number) => (await api.delete(`/admin/workflows/${id}`)).data,
  runs: async (id: number): Promise<WorkflowRun[]> => (await api.get<WorkflowRun[]>(`/admin/workflows/${id}/runs`)).data,
  approvals: async (): Promise<WorkflowApproval[]> => (await api.get<WorkflowApproval[]>('/admin/workflows/approvals')).data,
  actApproval: async (id: number, action: 'confirm' | 'deny') =>
    (await api.post(`/admin/workflows/approvals/${id}/${action}`)).data,
  testRun: async (
    id: number,
    body: { entityType?: string | null; entityId?: number | null; payload?: Record<string, unknown>; dryRun?: boolean },
  ): Promise<WorkflowTestResult> => (await api.post<WorkflowTestResult>(`/admin/workflows/${id}/test-run`, body)).data,
};

export interface WorkflowTestStep {
  node_key: string;
  node_type?: string | null;
  status: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

export interface WorkflowTestResult {
  runId: number;
  dryRun: boolean;
  status: string;
  steps: WorkflowTestStep[];
}
