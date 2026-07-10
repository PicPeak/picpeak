import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Webhook as WebhookIcon, Trash2, Copy, AlertTriangle, Activity, CheckCircle2, XCircle } from 'lucide-react';
import { Button, Card, Input, Loading } from '../../../components/common';
import { api } from '../../../config/api';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

const WEBHOOK_EVENT_TYPES = [
  'event.created',
  'event.published',
  'event.archived',
  'event.expired',
  'photo.uploaded',
  'photo.deleted',
] as const;
type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

interface WebhookRow {
  id: number;
  name: string;
  url: string;
  events: WebhookEventType[];
  active: boolean;
  secret_preview: string | null;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  owner_username: string | null;
}

/**
 * Settings → Webhooks tab (#327). Mirrors the API Tokens tab pattern:
 * the signing secret is returned exactly once on creation and never
 * recoverable. Per-webhook delivery history lives on the dedicated
 * /admin/webhooks/:id/deliveries page (link in the table).
 */
export const WebhooksTab: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>(['event.published']);
  const [filterText, setFilterText] = useState('{}');
  const [template, setTemplate] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [justCreatedSecret, setJustCreatedSecret] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);

  const { data: webhooks, isLoading } = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: async () => {
      const res = await api.get<WebhookRow[]>('/admin/webhooks');
      return res.data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      let parsedFilter: Record<string, unknown> = {};
      const trimmed = filterText.trim();
      if (trimmed && trimmed !== '{}') {
        try {
          parsedFilter = JSON.parse(trimmed);
        } catch {
          setFilterError(t('settings.webhooks.filterError', 'Filter must be valid JSON'));
          throw new Error('Invalid filter JSON');
        }
      }
      setFilterError(null);
      const body: Record<string, unknown> = { name, url, events, active: true };
      if (Object.keys(parsedFilter).length > 0) body.filter = parsedFilter;
      if (template.trim()) body.template = template;
      const res = await api.post<{ secret: string }>('/admin/webhooks', body);
      return res.data.secret;
    },
    onSuccess: (secret) => {
      setJustCreatedSecret(secret);
      setName('');
      setUrl('');
      setEvents(['event.published']);
      setFilterText('{}');
      setTemplate('');
      setShowAdvanced(false);
      queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] });
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.errors?.[0]?.msg || err?.response?.data?.error || t('settings.webhooks.createError', 'Failed to create webhook'));
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) =>
      api.put(`/admin/webhooks/${id}`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] }),
    onError: () => toast.error(t('settings.webhooks.updateError', 'Failed to update webhook')),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => api.delete(`/admin/webhooks/${id}`),
    onSuccess: () => {
      toast.success(t('settings.webhooks.deletedToast', 'Webhook deleted'));
      queryClient.invalidateQueries({ queryKey: ['admin-webhooks'] });
    },
    onError: () => toast.error(t('settings.webhooks.deleteError', 'Failed to delete webhook')),
  });

  const toggleEvent = (e: WebhookEventType) => {
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loading size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2 flex items-center gap-2">
          <WebhookIcon className="w-5 h-5" />
          {t('settings.webhooks.title', 'Webhooks')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.webhooks.subtitle', 'POST event notifications to your URL the moment something happens — gallery published, photo uploaded, event archived, etc. Signed with HMAC-SHA256 in the X-PicPeak-Signature header.')}
        </p>

        {/* PII notice (#341). event.* payloads include customer contact
           fields (name / email / phone) plus the share token. Make sure
           admins know what flows to a webhook receiver before they wire
           one up to a third-party automation tool. */}
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/20 p-3 mb-4 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
            {t(
              'settings.webhooks.piiNotice',
              'event.* payloads include customer contact info (name, email, phone) and the gallery share token if you have stored them. Only point webhooks at receivers you trust — they have everything needed to message the customer or open the gallery.'
            )}
          </p>
        </div>

        {justCreatedSecret && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 mb-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200 mb-1">
                  {t('settings.webhooks.copyNow', 'Copy this signing secret now — it will not be shown again.')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="block flex-1 min-w-0 px-3 py-2 bg-white dark:bg-neutral-900 border border-amber-300 dark:border-amber-700 rounded text-xs font-mono break-all">
                    {justCreatedSecret}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Copy className="w-4 h-4" />}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(justCreatedSecret);
                        toast.success(t('settings.webhooks.copied', 'Copied'));
                      } catch {
                        toast.error(t('settings.webhooks.copyFailed', 'Copy failed'));
                      }
                    }}
                  >
                    {t('settings.webhooks.copyButton', 'Copy')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setJustCreatedSecret(null)}>
                    {t('settings.webhooks.dismiss', 'Dismiss')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.webhooks.name', 'Name')}
              </label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.webhooks.namePlaceholder', 'e.g. n8n WhatsApp')} />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.webhooks.url', 'Receiver URL')}
              </label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('settings.webhooks.urlPlaceholder', 'https://n8n.example.com/webhook/picpeak')} />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              {t('settings.webhooks.events', 'Subscribe to events')}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {WEBHOOK_EVENT_TYPES.map((e) => (
                <label key={e} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={events.includes(e)}
                    onChange={() => toggleEvent(e)}
                    className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
                  />
                  <code className="text-xs">{e}</code>
                </label>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="text-sm text-primary-600 dark:text-primary-400 hover:underline self-start"
          >
            {showAdvanced ? t('settings.webhooks.hideAdvanced', '− Hide advanced (filter, template)') : t('settings.webhooks.showAdvanced', '+ Advanced (filter, template)')}
          </button>

          {showAdvanced && (
            <div className="space-y-3 border-l-2 border-neutral-200 dark:border-neutral-700 pl-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('settings.webhooks.filter', 'Filter (JSON, optional)')}
                </label>
                <textarea
                  value={filterText}
                  onChange={(e) => { setFilterText(e.target.value); setFilterError(null); }}
                  placeholder='{"data.event.event_type": "wedding"}'
                  rows={3}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded text-sm font-mono"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  {t('settings.webhooks.filterHelp', 'Dot-path → expected value. All keys must match (AND). Use an array for "any of".')} <code>{'{"type": ["event.published", "event.archived"]}'}</code>
                </p>
                {filterError && <p className="text-xs text-red-600 mt-1">{filterError}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('settings.webhooks.template', 'Template (optional)')}
                </label>
                <textarea
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  placeholder={t('settings.webhooks.templatePlaceholder', 'New gallery: ${data.event.event_name} → ${data.event.share_url}')}
                  rows={3}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded text-sm font-mono"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  {t('settings.webhooks.templateHelp', 'Replaces the default JSON envelope as the request body. ${dot.path} substitution from the payload only — no logic, no expressions.')}
                </p>
              </div>
            </div>
          )}

          <Button
            variant="primary"
            onClick={() => createMutation.mutate()}
            isLoading={createMutation.isPending}
            disabled={!name.trim() || !url.trim() || events.length === 0}
          >
            {t('settings.webhooks.create', 'Create Webhook')}
          </Button>
        </div>
      </Card>

      <Card padding="md">
        <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
          {t('settings.webhooks.existing', 'Existing webhooks')}
        </h3>
        {webhooks && webhooks.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
                  <th className="py-2 pr-3">{t('settings.webhooks.colName', 'Name')}</th>
                  <th className="py-2 pr-3">{t('settings.webhooks.colUrl', 'URL')}</th>
                  <th className="py-2 pr-3">{t('settings.webhooks.colEvents', 'Events')}</th>
                  <th className="py-2 pr-3">{t('settings.webhooks.colLastDelivery', 'Last delivery')}</th>
                  <th className="py-2 pr-3">{t('settings.webhooks.colStatus', 'Status')}</th>
                  <th className="py-2 text-right">{t('settings.webhooks.colActions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((wh) => {
                  const lastSuccess = wh.last_success_at ? new Date(wh.last_success_at) : null;
                  const lastFailure = wh.last_failure_at ? new Date(wh.last_failure_at) : null;
                  const lastEither = lastFailure && (!lastSuccess || lastFailure > lastSuccess) ? 'failure' : (lastSuccess ? 'success' : 'none');
                  return (
                    <tr key={wh.id} className="border-b border-neutral-100 dark:border-neutral-800 last:border-0 align-top">
                      <td className="py-3 pr-3 font-medium">{wh.name}</td>
                      <td className="py-3 pr-3 text-xs font-mono text-neutral-600 dark:text-neutral-400 max-w-xs truncate" title={wh.url}>{wh.url}</td>
                      <td className="py-3 pr-3 text-xs text-neutral-500">
                        {t('settings.webhooks.eventsSubscribed', { count: Array.isArray(wh.events) ? wh.events.length : 0 })}
                      </td>
                      <td className="py-3 pr-3 text-xs text-neutral-500">
                        {lastEither === 'success' && lastSuccess && (
                          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {fmtDateTime(lastSuccess)}
                          </span>
                        )}
                        {lastEither === 'failure' && lastFailure && (
                          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                            <XCircle className="w-3.5 h-3.5" />
                            {fmtDateTime(lastFailure)}
                          </span>
                        )}
                        {lastEither === 'none' && <span className="text-neutral-400">—</span>}
                      </td>
                      <td className="py-3 pr-3">
                        <button
                          onClick={() => toggleActiveMutation.mutate({ id: wh.id, active: !wh.active })}
                          className={`text-xs px-2 py-0.5 rounded ${
                            wh.active
                              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400'
                          }`}
                          title={wh.active ? t('settings.webhooks.toggleToDisable', 'Click to disable') : t('settings.webhooks.toggleToEnable', 'Click to enable')}
                        >
                          {wh.active ? t('settings.webhooks.statusActive', 'Active') : t('settings.webhooks.statusDisabled', 'Disabled')}
                        </button>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            to={`/admin/webhooks/${wh.id}/deliveries`}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                          >
                            <Activity className="w-3.5 h-3.5" />
                            {t('settings.webhooks.deliveriesLink', 'Deliveries')}
                          </Link>
                          <Button
                            size="sm"
                            variant="ghost"
                            leftIcon={<Trash2 className="w-4 h-4" />}
                            onClick={() => {
                              if (confirm(t('settings.webhooks.confirmDelete', { name: wh.name, defaultValue: `Delete "${wh.name}"? Pending deliveries are also removed.` }))) {
                                deleteMutation.mutate(wh.id);
                              }
                            }}
                          >
                            {t('settings.webhooks.delete', 'Delete')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('settings.webhooks.empty', 'No webhooks yet. Create one above to start receiving event notifications.')}
          </p>
        )}
      </Card>
    </div>
  );
};
