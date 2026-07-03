/**
 * Admin → Workflows → canvas editor (React Flow).
 *
 * Drag nodes from the palette, connect handle→handle (branch/gate/loop expose
 * yes/no · confirm/deny · loop/exit handles, labelled on the node), click a
 * node to edit it in the structured side panel, and Save (writes a new
 * version; in-flight runs keep theirs). The graph maps 1:1 onto
 * workflow_nodes/workflow_edges. Honours the admin light/dark theme.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  Handle, Position, type Connection, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { ArrowLeft, Save, Trash2, Wand2, Code } from 'lucide-react';
import { Button, Loading } from '../../../components/common';
import { api } from '../../../config/api';
import { useAdminDarkMode } from '../../../contexts/AdminDarkModeContext';
import { useMutationWithToast } from '../../../hooks';
import { workflowsService, type WorkflowNodeType } from '../../../services/workflows.service';
import { NodeConfigPanel } from './NodeConfigPanel';

const PALETTE: WorkflowNodeType[] = ['trigger', 'condition', 'branch', 'loop', 'wait', 'action', 'gate', 'webhook'];
const TRIGGERS = [
  'invoice.sent', 'invoice.paid', 'invoice.overdue',
  'quote.sent', 'quote.accepted', 'quote.declined',
  'contract.sent', 'contract.signed',
  'event.date_approaching',
  'gallery.published', 'gallery.expiring', 'gallery.expired',
  'customer.created',
];

const COLORS: Record<string, string> = {
  trigger: '#1D9E75', condition: '#BA7517', branch: '#BA7517', loop: '#378ADD',
  wait: '#888780', action: '#534AB7', gate: '#7F77DD', webhook: '#888780',
};
const SOURCE_HANDLES: Record<string, string[]> = {
  condition: ['yes', 'no'], branch: ['yes', 'no'], gate: ['confirm', 'deny'], loop: ['loop', 'exit'],
};

const WAIT_ANCHOR_LABEL: Record<string, string> = { dueDate: 'due date', issueDate: 'invoice date', eventDate: 'event date' };
const ACTION_LABEL: Record<string, string> = {
  queue_payment_check: 'Send payment-check email', escalate_to_collections: 'Collections handoff', send_email: 'Send email', reserve_date: 'Reserve the date',
  notify_pre_event: 'Send pre-event reminder', notify_gallery_expiring: 'Send gallery-expiring warning', notify_gallery_expired: 'Send gallery-expired email',
  prepare_quote: 'Prepare quote', prepare_contract: 'Prepare contract', prepare_invoice: 'Prepare invoice',
  prepare_event: 'Create event', prepare_gallery: 'Create gallery', send_document: 'Send document',
  webhook: 'Call webhook', noop: 'Do nothing', set_context: 'Set value',
};

// Human-readable label derived live from a node's type + config.
function describeNode(type: string, config: any = {}, triggerType?: string): string {
  const c = config || {};
  switch (type) {
    case 'trigger': return triggerType || 'When…';
    case 'wait':
      if (c.untilVar) return `Wait until ${WAIT_ANCHOR_LABEL[c.untilVar] || c.untilVar}`;
      return `Wait ${[c.delayDays && `${c.delayDays}d`, c.delayHours && `${c.delayHours}h`, c.delayMinutes && `${c.delayMinutes}m`].filter(Boolean).join(' ') || '…'}`;
    case 'condition':
    case 'branch':
      if (c.condition === 'invoice_paid') return 'Invoice paid?';
      if (c.condition === 'expr') return `${c.field || 'field'} ${c.op || ''} ${c.value ?? ''}`.trim();
      if (c.condition === 'always') return 'Always';
      if (c.condition === 'never') return 'Never';
      return c.condition || 'Condition';
    case 'loop': return `Repeat ≤ ${c.maxIterations ?? 3}×`;
    case 'action': return ACTION_LABEL[c.action] || c.action || 'Action';
    case 'gate': return c.prompt ? `Ask: ${String(c.prompt).slice(0, 28)}${String(c.prompt).length > 28 ? '…' : ''}` : 'Admin confirm';
    case 'webhook': return 'Call webhook';
    default: return type;
  }
}

function WfNode({ data }: { data: any }) {
  const handles = SOURCE_HANDLES[data.nodeType];
  const color = COLORS[data.nodeType] || '#888780';
  const label = describeNode(data.nodeType, data.config, data.triggerType);
  const pos = (i: number, n: number) => `${(100 / (n + 1)) * (i + 1)}%`;
  return (
    <div style={{ borderColor: color }} className="relative rounded-md border-2 bg-white dark:bg-neutral-900 px-3 pt-2 pb-4 min-w-[152px] text-center shadow-sm">
      {data.nodeType !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div className="text-[10px] uppercase tracking-wide" style={{ color }}>{data.nodeType}</div>
      <div className="text-sm text-neutral-900 dark:text-neutral-100">{label}</div>
      {handles ? handles.map((h, i) => (
        <React.Fragment key={h}>
          <span className="absolute text-[9px] text-neutral-400 dark:text-neutral-500" style={{ bottom: 3, left: pos(i, handles.length), transform: 'translateX(-50%)' }}>{h}</span>
          <Handle id={h} type="source" position={Position.Bottom} style={{ left: pos(i, handles.length) }} />
        </React.Fragment>
      )) : <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}

const nodeTypes = { wf: WfNode };

// Tidy the graph into a top-to-bottom tree with dagre (handles the loop-back
// cycle by breaking it internally).
function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 70, ranksep: 80 });
  const W = 170;
  const H = 70;
  nodes.forEach((n) => g.setNode(n.id, { width: W, height: H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return p ? { ...n, position: { x: p.x - W / 2, y: p.y - H / 2 } } : n;
  });
}

export const WorkflowEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isDark } = useAdminDarkMode();
  const { id } = useParams<{ id: string }>();
  const workflowId = Number(id);

  const { data: workflow, isLoading } = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => workflowsService.get(workflowId),
    enabled: Number.isFinite(workflowId),
  });

  // Configured webhook subscriptions — the webhook node references one of these
  // (the delivery then rides the webhook worker pipeline).
  const { data: webhooks = [] } = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: async () => (await api.get<Array<{ id: number; name: string; active: boolean }>>('/admin/webhooks')).data,
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState('invoice.sent');
  const [triggerConfig, setTriggerConfig] = useState<Record<string, any>>({});
  const [enabled, setEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counter, setCounter] = useState(1);
  const rfRef = useRef<any>(null);

  const cleanUp = useCallback(() => {
    setNodes((nds) => layoutGraph(nds, edges));
    setTimeout(() => rfRef.current?.fitView?.({ padding: 0.2, duration: 300 }), 60);
  }, [edges, setNodes]);

  // --- Advanced text mode: the whole flow as JSON (share / LLM round-trip) ---
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState('');
  const [textErr, setTextErr] = useState<string | null>(null);

  const serializeFlow = () => JSON.stringify({
    name,
    trigger_type: triggerType,
    trigger_config: triggerConfig,
    enabled,
    nodes: nodes.map((n) => ({
      node_key: n.id, type: (n.data as any).nodeType, config: (n.data as any).config || {},
      pos_x: Math.round(n.position.x), pos_y: Math.round(n.position.y),
    })),
    edges: edges.map((e) => ({ from_node: e.source, from_handle: e.sourceHandle || null, to_node: e.target })),
  }, null, 2);

  const openText = () => { setText(serializeFlow()); setTextErr(null); setTextMode(true); };

  const applyText = () => {
    let p: any;
    try { p = JSON.parse(text); } catch (e) { setTextErr(t('workflows.editor.badJson', 'Config is not valid JSON') as string); return; }
    if (!Array.isArray(p.nodes) || !Array.isArray(p.edges)) { setTextErr(t('workflows.editor.textNeedsArrays', 'Needs "nodes" and "edges" arrays') as string); return; }
    if (p.nodes.filter((n: any) => n.type === 'trigger').length !== 1) { setTextErr(t('workflows.editor.textNeedsTrigger', 'Needs exactly one trigger node') as string); return; }
    const tt = p.trigger_type || triggerType;
    if (p.name != null) setName(p.name);
    if (p.trigger_type) setTriggerType(p.trigger_type);
    if (p.trigger_config && typeof p.trigger_config === 'object') setTriggerConfig(p.trigger_config);
    if (p.enabled != null) setEnabled(!!p.enabled);
    setNodes(p.nodes.map((n: any) => ({
      id: n.node_key, type: 'wf', position: { x: n.pos_x || 0, y: n.pos_y || 0 },
      data: { nodeType: n.type, config: n.config || {}, triggerType: tt },
    })));
    setEdges(p.edges.map((e: any, i: number) => ({
      id: `e${i}`, source: e.from_node, target: e.to_node, sourceHandle: e.from_handle || undefined, label: e.from_handle || undefined,
    })));
    setTextErr(null);
    setTextMode(false);
    toast.success(t('workflows.editor.textLoaded', 'Loaded — review and Save') as string);
  };

  const copyText = () => { navigator.clipboard?.writeText(text); toast.success(t('common.copied', 'Copied') as string); };

  useEffect(() => {
    if (!workflow) return;
    setName(workflow.name);
    setTriggerType(workflow.trigger_type);
    setTriggerConfig((workflow.trigger_config as Record<string, any>) || {});
    setEnabled(workflow.enabled === true || workflow.enabled === 1);
    setNodes(workflow.nodes.map((n) => ({
      id: n.node_key,
      type: 'wf',
      position: { x: n.pos_x || 0, y: n.pos_y || 0 },
      data: { nodeType: n.type, config: n.config || {}, triggerType: workflow.trigger_type },
    })));
    setEdges(workflow.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from_node,
      target: e.to_node,
      sourceHandle: e.from_handle || undefined,
      label: e.from_handle || undefined,
    })));
  }, [workflow, setNodes, setEdges]);

  // Keep the trigger node's label in sync when the trigger is changed in the toolbar.
  useEffect(() => {
    setNodes((nds) => nds.map((n) => (n.data?.nodeType === 'trigger' ? { ...n, data: { ...n.data, triggerType } } : n)));
  }, [triggerType, setNodes]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, label: c.sourceHandle || undefined }, eds));
  }, [setEdges]);

  const addNode = (type: WorkflowNodeType) => {
    const key = type === 'trigger' ? `trigger_${counter}` : `${type}_${counter}`;
    setCounter((c) => c + 1);
    setNodes((nds) => nds.concat({
      id: key, type: 'wf', position: { x: 140 + Math.random() * 220, y: 140 + Math.random() * 220 },
      data: { nodeType: type, config: {}, triggerType },
    }));
  };

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);

  const updateNodeConfig = (nodeId: string, config: Record<string, unknown>) => {
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, config } } : n)));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  const saveMutation = useMutationWithToast({
    mutationFn: () => workflowsService.update(workflowId, {
      name: name.trim() || 'Untitled',
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      enabled,
      nodes: nodes.map((n) => ({
        node_key: n.id, type: (n.data as any).nodeType, config: (n.data as any).config || {},
        pos_x: Math.round(n.position.x), pos_y: Math.round(n.position.y),
      })),
      edges: edges.map((e) => ({ from_node: e.source, from_handle: e.sourceHandle || null, to_node: e.target })),
    }),
    successMessage: t('workflows.editor.saved', 'Workflow saved') as string,
    invalidateKeys: [['workflow', workflowId], ['workflows']],
    errorMessage: t('workflows.editor.saveFailed', 'Could not save') as string,
  });

  if (isLoading) return <div className="p-10"><Loading /></div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/workflows')} aria-label={t('common.back', 'Back') as string}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          className="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
          placeholder={t('workflows.editor.namePlaceholder', 'Workflow name') as string}
        />
        <label className="text-sm text-neutral-600 dark:text-neutral-400">{t('workflows.editor.when', 'When')}</label>
        <select
          value={triggerType} onChange={(e) => setTriggerType(e.target.value)}
          className="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm"
        >
          {TRIGGERS.map((tr) => <option key={tr} value={tr}>{tr}</option>)}
        </select>
        {triggerType === 'event.date_approaching' && (
          <label className="text-sm text-neutral-600 dark:text-neutral-400 flex items-center gap-1.5">
            {t('workflows.editor.daysBefore', 'days before event')}
            <input
              type="number" min={0} max={365}
              value={triggerConfig.daysBefore ?? 2}
              onChange={(e) => setTriggerConfig((c) => ({ ...c, daysBefore: Number(e.target.value) }))}
              className="w-16 px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm"
            />
          </label>
        )}
        <label className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('workflows.enabled', 'Enabled')}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => (textMode ? setTextMode(false) : openText())} leftIcon={<Code className="w-4 h-4" />}>
            {textMode ? t('workflows.editor.canvasView', 'Canvas') : t('workflows.editor.textView', 'Text')}
          </Button>
          <Button variant="primary" isLoading={saveMutation.isPending} onClick={() => saveMutation.mutate()} leftIcon={<Save className="w-4 h-4" />}>
            {t('common.saveChanges', 'Save changes')}
          </Button>
        </div>
      </div>

      {!textMode && (
      <div className="flex flex-wrap items-center gap-2">
        {PALETTE.map((type) => (
          <button
            key={type} type="button" onClick={() => addNode(type)}
            className="text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            + {type}
          </button>
        ))}
        <button
          type="button" onClick={cleanUp}
          className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          <Wand2 className="w-3.5 h-3.5" /> {t('workflows.editor.cleanUp', 'Clean up layout')}
        </button>
      </div>
      )}

      {textMode ? (
        <div className="space-y-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('workflows.editor.textHint', 'The whole flow as JSON — copy it to share or hand to an LLM, or paste a flow and load it into the editor. Click “Clean up layout” after importing.')}
          </p>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
            className="w-full font-mono text-xs p-2 rounded border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
            style={{ height: '62vh' }}
          />
          {textErr && <p className="text-xs text-red-600 dark:text-red-400">{textErr}</p>}
          <div className="flex gap-2">
            <Button variant="outline" onClick={copyText}>{t('common.copy', 'Copy')}</Button>
            <Button variant="primary" onClick={applyText}>{t('workflows.editor.loadText', 'Load into editor')}</Button>
          </div>
        </div>
      ) : (
      <div className="flex gap-3" style={{ height: '70vh' }}>
        <div className="flex-1 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <ReactFlow
            colorMode={isDark ? 'dark' : 'light'}
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)} onInit={(inst) => { rfRef.current = inst; }} fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {selectedNode && (
          <div className="w-80 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 space-y-3 bg-white dark:bg-neutral-900 overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {(selectedNode.data as any).nodeType} · {selectedNode.id}
              </div>
              <Button variant="ghost" size="sm" onClick={deleteSelected} aria-label={t('common.delete', 'Delete') as string}>
                <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
              </Button>
            </div>
            <NodeConfigPanel
              nodeType={(selectedNode.data as any).nodeType}
              config={(selectedNode.data as any).config || {}}
              onChange={(cfg) => updateNodeConfig(selectedNode.id, cfg)}
              webhooks={webhooks}
            />
          </div>
        )}
      </div>
      )}
    </div>
  );
};
