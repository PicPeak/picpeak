import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, RefreshCw, RotateCw, Send, X, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { Button, Card, Loading } from '../../components/common';
import { api } from '../../config/api';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

const WEBHOOK_EVENT_TYPES = [
  'event.created',
  'event.published',
  'event.archived',
  'event.expired',
  'photo.uploaded',
  'photo.deleted',
] as const;

interface DeliveryRow {
  id: number;
  event_type: string;
  attempt_count: number;
  status: 'pending' | 'success' | 'failed';
  response_status: number | null;
  latency_ms: number | null;
  next_retry_at: string | null;
  created_at: string;
  completed_at: string | null;
  last_error: string | null;
}

interface DeliveryDetail extends DeliveryRow {
  webhook_id: number;
  payload: Record<string, unknown>;
  response_body: string | null;
}

interface WebhookDetail {
  id: number;
  name: string;
  url: string;
  events: string[];
  active: boolean;
}

const STATUS_FILTERS = ['all', 'pending', 'success', 'failed'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

function statusBadge(status: string) {
  const map: Record<string, string> = {
    success: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
    pending: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    failed: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
  };
  return map[status] || 'bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400';
}

/**
 * Operational view for #327 — the rich debug surface that the Settings →
 * Webhooks tab links into. Without this page every "is my webhook
 * working?" question becomes a support ticket, exactly what Stripe and
 * GitHub avoid by shipping a similar split.
 */
export const WebhookDeliveriesPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const webhookId = parseInt(id || '', 10);
  const queryClient = useQueryClient();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();

  const [filter, setFilter] = useState<StatusFilter>('all');
  const [openDeliveryId, setOpenDeliveryId] = useState<number | null>(null);
  const [showTestDialog, setShowTestDialog] = useState(false);
  const [testEventType, setTestEventType] = useState<string>('event.published');

  const { data: webhook, isLoading: loadingWebhook } = useQuery({
    queryKey: ['admin-webhook', webhookId],
    queryFn: async () => {
      const res = await api.get<WebhookDetail>(`/admin/webhooks/${webhookId}`);
      return res.data;
    },
    enabled: Number.isFinite(webhookId),
  });

  // Auto-refresh every 10s — tight enough that admins see new attempts land
  // without manual reload, loose enough not to thrash the backend.
  const deliveriesQuery = useQuery({
    queryKey: ['admin-webhook-deliveries', webhookId, filter],
    queryFn: async () => {
      const params: Record<string, string> = { limit: '50' };
      if (filter !== 'all') params.status = filter;
      const res = await api.get<{ deliveries: DeliveryRow[]; pagination: { total: number } }>(
        `/admin/webhooks/${webhookId}/deliveries`,
        { params }
      );
      return res.data;
    },
    enabled: Number.isFinite(webhookId),
    refetchInterval: 10_000,
    refetchOnWindowFocus: 'always',
  });

  const detailQuery = useQuery({
    queryKey: ['admin-webhook-delivery', webhookId, openDeliveryId],
    queryFn: async () => {
      const res = await api.get<DeliveryDetail>(`/admin/webhooks/${webhookId}/deliveries/${openDeliveryId}`);
      return res.data;
    },
    enabled: Number.isFinite(webhookId) && openDeliveryId !== null,
  });

  const replayMutation = useMutation({
    mutationFn: async (deliveryId: number) =>
      api.post(`/admin/webhooks/${webhookId}/deliveries/${deliveryId}/replay`),
    onSuccess: () => {
      toast.success('Replay enqueued');
      queryClient.invalidateQueries({ queryKey: ['admin-webhook-deliveries', webhookId] });
    },
    onError: () => toast.error('Failed to replay'),
  });

  const testMutation = useMutation({
    mutationFn: async () => api.post(`/admin/webhooks/${webhookId}/test`, { event_type: testEventType }),
    onSuccess: () => {
      toast.success('Test event enqueued');
      setShowTestDialog(false);
      queryClient.invalidateQueries({ queryKey: ['admin-webhook-deliveries', webhookId] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || 'Failed to send test'),
  });

  if (loadingWebhook) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" />
      </div>
    );
  }

  if (!webhook) {
    return (
      <div className="p-6">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Webhook not found.</p>
        <Link to="/admin/settings" className="text-accent hover:underline">← Back to settings</Link>
      </div>
    );
  }

  const deliveries = deliveriesQuery.data?.deliveries || [];
  const total = deliveriesQuery.data?.pagination.total || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link
            to="/admin/settings"
            className="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Settings
          </Link>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{webhook.name}</h1>
          <p className="text-sm font-mono text-neutral-500 dark:text-neutral-400 mt-1 break-all">{webhook.url}</p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {webhook.events.map((e) => (
              <span key={e} className="text-xs px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 font-mono">
                {e}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Send className="w-4 h-4" />}
            onClick={() => setShowTestDialog(true)}
          >
            Send test event
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RefreshCw className="w-4 h-4" />}
            onClick={() => deliveriesQuery.refetch()}
          >
            Refresh
          </Button>
        </div>
      </div>

      <Card padding="md">
        <div className="flex items-center gap-2 mb-3">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-xs px-3 py-1 rounded-full ${
                filter === s
                  ? 'bg-accent-dark text-white'
                  : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200'
              }`}
            >
              {s}
            </button>
          ))}
          <span className="ml-auto text-xs text-neutral-500">{total} total</span>
        </div>

        {deliveriesQuery.isLoading ? (
          <Loading size="md" />
        ) : deliveries.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400 py-8 text-center">
            No deliveries yet. Create an event or send a test event to see something here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
                  <th className="py-2 pr-3">Time</th>
                  <th className="py-2 pr-3">Event</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Attempts</th>
                  <th className="py-2 pr-3">HTTP</th>
                  <th className="py-2 pr-3">Latency</th>
                  <th className="py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-neutral-100 dark:border-neutral-800 last:border-0 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                    onClick={() => setOpenDeliveryId(d.id)}
                  >
                    <td className="py-2.5 pr-3 text-xs text-neutral-600 dark:text-neutral-400">
                      {fmtDateTime(d.created_at)}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs">{d.event_type}</td>
                    <td className="py-2.5 pr-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${statusBadge(d.status)}`}>
                        {d.status === 'success' && <CheckCircle2 className="w-3 h-3 inline mr-1" />}
                        {d.status === 'pending' && <Clock className="w-3 h-3 inline mr-1" />}
                        {d.status === 'failed' && <AlertCircle className="w-3 h-3 inline mr-1" />}
                        {d.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs">{d.attempt_count}</td>
                    <td className="py-2.5 pr-3 text-xs font-mono">{d.response_status ?? '—'}</td>
                    <td className="py-2.5 pr-3 text-xs text-neutral-500">{d.latency_ms != null ? `${d.latency_ms}ms` : '—'}</td>
                    <td className="py-2.5 text-right">
                      {d.status === 'failed' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<RotateCw className="w-3.5 h-3.5" />}
                          onClick={(e) => {
                            e.stopPropagation();
                            replayMutation.mutate(d.id);
                          }}
                        >
                          Replay
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Slide-over with delivery detail */}
      {openDeliveryId !== null && (
        <div className="fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpenDeliveryId(null)}
          />
          <div className="relative ml-auto w-full max-w-2xl h-full bg-white dark:bg-neutral-900 shadow-xl overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                Delivery #{openDeliveryId}
              </h2>
              <Button size="sm" variant="ghost" onClick={() => setOpenDeliveryId(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {detailQuery.isLoading || !detailQuery.data ? (
              <Loading size="md" />
            ) : (
              <div className="space-y-4 text-sm">
                <div>
                  <span className="block text-xs text-neutral-500">Event type</span>
                  <code className="text-sm">{detailQuery.data.event_type}</code>
                </div>
                <div>
                  <span className="block text-xs text-neutral-500">Status</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${statusBadge(detailQuery.data.status)}`}>
                    {detailQuery.data.status}
                  </span>
                </div>
                {detailQuery.data.last_error && (
                  <div>
                    <span className="block text-xs text-neutral-500">Last error</span>
                    <pre className="text-xs whitespace-pre-wrap break-words bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded p-2">
                      {detailQuery.data.last_error}
                    </pre>
                  </div>
                )}
                {detailQuery.data.response_status != null && (
                  <div>
                    <span className="block text-xs text-neutral-500">Response status</span>
                    <code className="text-sm">{detailQuery.data.response_status}</code>
                  </div>
                )}
                {detailQuery.data.response_body && (
                  <div>
                    <span className="block text-xs text-neutral-500">Response body (truncated to 1KB)</span>
                    <pre className="text-xs whitespace-pre-wrap break-words bg-neutral-50 dark:bg-neutral-800 rounded p-2 max-h-40 overflow-y-auto">
                      {detailQuery.data.response_body}
                    </pre>
                  </div>
                )}
                <div>
                  <span className="block text-xs text-neutral-500">Payload (signed body)</span>
                  <pre className="text-xs whitespace-pre-wrap break-words bg-neutral-50 dark:bg-neutral-800 rounded p-2 max-h-80 overflow-y-auto">
                    {JSON.stringify(detailQuery.data.payload, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Test event dialog */}
      {showTestDialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={() => setShowTestDialog(false)}>
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-3">Send test event</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
              Fires a synthetic delivery to your receiver with a stub payload, no actual side effects.
            </p>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Event type</label>
            <select
              value={testEventType}
              onChange={(e) => setTestEventType(e.target.value)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded text-sm mb-4"
            >
              {WEBHOOK_EVENT_TYPES.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowTestDialog(false)}>Cancel</Button>
              <Button variant="primary" isLoading={testMutation.isPending} onClick={() => testMutation.mutate()}>
                Send
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
