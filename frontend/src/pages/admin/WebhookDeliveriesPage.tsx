import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, RotateCw, Send, AlertCircle, CheckCircle2, Clock, Webhook } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Modal, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from '../../components/common';
import type { BadgeTone } from '../../components/common';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';
import { api } from '../../config/api';
import { useModal, useMutationWithToast } from '../../hooks';
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

function statusTone(status: string): BadgeTone {
  const map: Record<string, BadgeTone> = {
    success: 'success',
    pending: 'warning',
    failed: 'danger',
  };
  return map[status] || 'neutral';
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
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();

  const [filter, setFilter] = useState<StatusFilter>('all');
  const [openDeliveryId, setOpenDeliveryId] = useState<number | null>(null);
  const testDialog = useModal();
  const [testEventType, setTestEventType] = useState<string>('event.published');

  const { data: webhook, isLoading: loadingWebhook, isError: webhookError, isRefetching: refetchingWebhook, refetch: refetchWebhook } = useQuery({
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

  const replayMutation = useMutationWithToast({
    mutationFn: async (deliveryId: number) =>
      api.post(`/admin/webhooks/${webhookId}/deliveries/${deliveryId}/replay`),
    invalidateKeys: [['admin-webhook-deliveries', webhookId]],
    successMessage: t('settings.webhooks.deliveries.replayEnqueued', 'Replay enqueued'),
    errorMessage: () => t('settings.webhooks.deliveries.replayError', 'Failed to replay'),
  });

  const testMutation = useMutationWithToast({
    mutationFn: async () => api.post(`/admin/webhooks/${webhookId}/test`, { event_type: testEventType }),
    invalidateKeys: [['admin-webhook-deliveries', webhookId]],
    successMessage: t('settings.webhooks.deliveries.testEnqueued', 'Test event enqueued'),
    errorMessage: t('settings.webhooks.deliveries.testError', 'Failed to send test'),
    onSuccess: () => {
      testDialog.close();
    },
  });

  if (loadingWebhook) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" />
      </div>
    );
  }

  if (!webhook) {
    // "Couldn't load" and "doesn't exist" are different answers: a 404 is
    // the second, anything else the first.
    const status = (webhookError as unknown as { response?: { status?: number } } | null)?.response?.status;
    if (webhookError && status !== 404) {
      return (
        <ErrorState
          title={t('settings.webhooks.deliveries.loadFailed', 'Could not load this webhook')}
          onRetry={() => refetchWebhook()}
          retrying={refetchingWebhook}
        />
      );
    }
    return (
      <EmptyState
        icon={<Webhook />}
        title={t('settings.webhooks.deliveries.notFound', 'Webhook not found.')}
        description={t('settings.webhooks.deliveries.notFoundHint', 'It may have been deleted. Settings › Webhooks lists the ones that exist.')}
        action={(
          <Link to="/admin/settings?tab=webhooks" className="btn btn-outline btn-sm inline-flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            {t('settings.webhooks.deliveries.back', 'Back to Settings')}
          </Link>
        )}
      />
    );
  }

  const deliveries = deliveriesQuery.data?.deliveries || [];
  const total = deliveriesQuery.data?.pagination.total || 0;

  return (
    <div className="space-y-6">
      <div>
        {/* Webhooks live in a Settings tab, not in the sidebar, so the page
            keeps its way back (UX.md § 9). */}
        <Link
          to="/admin/settings?tab=webhooks"
          className="inline-flex items-center gap-1 mb-3 text-sm text-soft hover:text-heading"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('settings.webhooks.deliveries.back', 'Back to Settings')}
        </Link>
        <SectionPageHeader
          icon={Webhook}
          title={webhook.name}
          className="mb-0"
          actions={(
            <>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<RefreshCw className="w-4 h-4" />}
                onClick={() => deliveriesQuery.refetch()}
              >
                {t('settings.webhooks.deliveries.refresh', 'Refresh')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Send className="w-4 h-4" />}
                onClick={() => testDialog.open()}
              >
                {t('settings.webhooks.deliveries.sendTest', 'Send test event')}
              </Button>
            </>
          )}
        />
        <p className="text-sm font-mono text-muted mt-1 break-all">{webhook.url}</p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {webhook.events.map((e) => (
            <span key={e} className="text-xs px-2 py-0.5 rounded bg-subtle text-soft font-mono">
              {e}
            </span>
          ))}
        </div>
      </div>

      <Card padding="md">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              aria-pressed={filter === s}
              className={`text-xs px-3 py-1 rounded-full ${
                filter === s
                  ? 'bg-accent-strong text-accent-fg'
                  : 'bg-subtle text-soft hover:bg-hover'
              }`}
            >
              {t(`settings.webhooks.deliveries.status.${s}`, s)}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted">
            {t('settings.webhooks.deliveries.total', '{{count}} total', { count: total })}
          </span>
        </div>

        {deliveriesQuery.isLoading ? (
          <Loading size="md" />
        ) : deliveriesQuery.isError && !deliveriesQuery.data ? (
          <ErrorState
            size="inline"
            title={t('settings.webhooks.deliveries.listLoadFailed', 'Could not load the deliveries')}
            onRetry={() => deliveriesQuery.refetch()}
            retrying={deliveriesQuery.isRefetching}
          />
        ) : deliveries.length === 0 ? (
          <EmptyState
            size="inline"
            title={t('settings.webhooks.deliveries.emptyTitle', 'No deliveries yet')}
            description={t(
              'settings.webhooks.deliveries.empty',
              'Create a gallery or send a test event to see deliveries here.'
            )}
            action={(
              <Button variant="outline" size="sm" leftIcon={<Send className="w-4 h-4" />} onClick={() => testDialog.open()}>
                {t('settings.webhooks.deliveries.sendTest', 'Send test event')}
              </Button>
            )}
          />
        ) : (
          <Table containerClassName="border-0 rounded-none">
            <TableHead>
              <tr>
                <TableHeaderCell>{t('settings.webhooks.deliveries.colTime', 'Time')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.webhooks.deliveries.colEvent', 'Event')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.webhooks.deliveries.colStatus', 'Status')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.webhooks.deliveries.colAttempts', 'Attempts')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.webhooks.deliveries.colHttp', 'HTTP')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.webhooks.deliveries.colLatency', 'Latency')}</TableHeaderCell>
                <TableHeaderCell align="right"><span className="sr-only">{t('common.actions', 'Actions')}</span></TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow
                  key={d.id}
                  interactive
                  onClick={() => setOpenDeliveryId(d.id)}
                >
                  <TableCell className="text-xs text-soft">
                    {fmtDateTime(d.created_at)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{d.event_type}</TableCell>
                  <TableCell>
                    <Badge
                      tone={statusTone(d.status)}
                      icon={d.status === 'success' ? <CheckCircle2 /> : d.status === 'pending' ? <Clock /> : d.status === 'failed' ? <AlertCircle /> : undefined}
                    >
                      {t(`settings.webhooks.deliveries.status.${d.status}`, d.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{d.attempt_count}</TableCell>
                  <TableCell className="text-xs font-mono">{d.response_status ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted">{d.latency_ms != null ? `${d.latency_ms}ms` : '—'}</TableCell>
                  <TableCell align="right">
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
                        {t('settings.webhooks.deliveries.replay', 'Replay')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Delivery detail */}
      <Modal
        open={openDeliveryId !== null}
        onClose={() => setOpenDeliveryId(null)}
        title={t('settings.webhooks.deliveries.detailTitle', 'Delivery #{{id}}', { id: openDeliveryId })}
        size="lg"
      >
        {detailQuery.isLoading || !detailQuery.data ? (
          <Loading size="md" />
        ) : (
          <div className="space-y-4 text-sm">
            <div>
              <span className="block text-xs text-muted">
                {t('settings.webhooks.deliveries.eventType', 'Event type')}
              </span>
              <code className="text-sm">{detailQuery.data.event_type}</code>
            </div>
            <div>
              <span className="block text-xs text-muted">
                {t('settings.webhooks.deliveries.colStatus', 'Status')}
              </span>
              <Badge tone={statusTone(detailQuery.data.status)}>
                {t(`settings.webhooks.deliveries.status.${detailQuery.data.status}`, detailQuery.data.status)}
              </Badge>
            </div>
            {detailQuery.data.last_error && (
              <div>
                <span className="block text-xs text-muted">
                  {t('settings.webhooks.deliveries.lastError', 'Last error')}
                </span>
                <pre className="text-xs whitespace-pre-wrap break-words bg-danger-soft text-danger-text rounded p-2">
                  {detailQuery.data.last_error}
                </pre>
              </div>
            )}
            {detailQuery.data.response_status != null && (
              <div>
                <span className="block text-xs text-muted">
                  {t('settings.webhooks.deliveries.responseStatus', 'Response status')}
                </span>
                <code className="text-sm">{detailQuery.data.response_status}</code>
              </div>
            )}
            {detailQuery.data.response_body && (
              <div>
                <span className="block text-xs text-muted">
                  {t('settings.webhooks.deliveries.responseBody', 'Response body (truncated to 1KB)')}
                </span>
                <pre className="text-xs whitespace-pre-wrap break-words bg-subtle rounded p-2 max-h-40 overflow-y-auto">
                  {detailQuery.data.response_body}
                </pre>
              </div>
            )}
            <div>
              <span className="block text-xs text-muted">
                {t('settings.webhooks.deliveries.payload', 'Payload (signed body)')}
              </span>
              <pre className="text-xs whitespace-pre-wrap break-words bg-subtle rounded p-2 max-h-80 overflow-y-auto">
                {JSON.stringify(detailQuery.data.payload, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Modal>

      {/* Test event dialog */}
      <Modal
        open={testDialog.isOpen}
        onClose={() => testDialog.close()}
        title={t('settings.webhooks.deliveries.sendTest', 'Send test event')}
        description={t(
          'settings.webhooks.deliveries.sendTestHelp',
          'Fires a synthetic delivery to your receiver with a stub payload, no actual side effects.'
        )}
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => testDialog.close()}>{t('common.cancel', 'Cancel')}</Button>
            <Button variant="primary" isLoading={testMutation.isPending} onClick={() => testMutation.mutate()}>
              {t('settings.webhooks.deliveries.send', 'Send')}
            </Button>
          </>
        )}
      >
        <label htmlFor="webhook-test-event-type" className="block text-sm font-medium text-body mb-1">
          {t('settings.webhooks.deliveries.eventType', 'Event type')}
        </label>
        <select
          id="webhook-test-event-type"
          value={testEventType}
          onChange={(e) => setTestEventType(e.target.value)}
          className="w-full px-3 py-2 border border-line-strong bg-panel text-heading rounded-lg text-sm"
        >
          {WEBHOOK_EVENT_TYPES.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </Modal>
    </div>
  );
};
