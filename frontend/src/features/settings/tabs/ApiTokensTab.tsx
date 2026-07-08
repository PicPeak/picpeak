import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { KeyRound, Trash2, Copy, AlertTriangle } from 'lucide-react';
import { Button, Card, Input, Loading } from '../../../components/common';
import { api } from '../../../config/api';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

interface ApiTokenRow {
  id: number;
  name: string;
  scopes: string;
  preview: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  owner_username: string | null;
}

const ALL_SCOPES: Array<'read' | 'write' | 'admin'> = ['read', 'write', 'admin'];

/**
 * Admin tab for managing API tokens (#322). Lists active tokens, lets
 * admins generate new ones (plaintext shown ONCE), and revokes them.
 * The plaintext token is returned only on creation — there is no way
 * to retrieve it again, by design.
 */
export const ApiTokensTab: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime, format: fmtDate } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Array<'read' | 'write' | 'admin'>>(['read']);
  const [justCreatedToken, setJustCreatedToken] = useState<string | null>(null);

  const { data: tokens, isLoading } = useQuery({
    queryKey: ['admin-api-tokens'],
    queryFn: async () => {
      const res = await api.get<ApiTokenRow[]>('/admin/api-tokens');
      return res.data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ token: string }>('/admin/api-tokens', { name, scopes });
      return res.data.token;
    },
    onSuccess: (token) => {
      setJustCreatedToken(token);
      setName('');
      setScopes(['read']);
      queryClient.invalidateQueries({ queryKey: ['admin-api-tokens'] });
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || t('settings.apiTokens.createError', 'Failed to create token'));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: number) => api.delete(`/admin/api-tokens/${id}`),
    onSuccess: () => {
      toast.success(t('settings.apiTokens.revoked', 'Token revoked'));
      queryClient.invalidateQueries({ queryKey: ['admin-api-tokens'] });
    },
    onError: () => toast.error(t('toast.saveError')),
  });

  const toggleScope = (scope: 'read' | 'write' | 'admin') => {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
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
          <KeyRound className="w-5 h-5" />
          {t('settings.apiTokens.title', 'API Tokens')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.apiTokens.subtitle', 'Long-lived bearer tokens for the public /api/v1 surface — n8n integrations, custom apps, scripts. Tokens act as the admin user that minted them, intersected with the chosen scopes.')}
        </p>

        {justCreatedToken && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 mb-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200 mb-1">
                  {t('settings.apiTokens.copyNow', 'Copy this token now — it will not be shown again.')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="block flex-1 min-w-0 px-3 py-2 bg-white dark:bg-neutral-900 border border-amber-300 dark:border-amber-700 rounded text-xs font-mono break-all">
                    {justCreatedToken}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<Copy className="w-4 h-4" />}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(justCreatedToken);
                        toast.success(t('settings.apiTokens.copied', 'Copied'));
                      } catch {
                        toast.error(t('settings.apiTokens.copyFailed', 'Copy failed'));
                      }
                    }}
                  >
                    {t('events.copy', 'Copy')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setJustCreatedToken(null)}>
                    {t('common.dismiss', 'Dismiss')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-2">
          <div className="md:col-span-1">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.apiTokens.name', 'Name')}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.apiTokens.namePlaceholder', 'e.g. n8n production')}
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.apiTokens.scopes', 'Scopes')}
            </label>
            <div className="flex gap-3 pt-2">
              {ALL_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={() => toggleScope(s)}
                    className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>
          <div className="md:col-span-1">
            <Button
              variant="primary"
              onClick={() => createMutation.mutate()}
              isLoading={createMutation.isPending}
              disabled={!name.trim() || scopes.length === 0}
            >
              {t('settings.apiTokens.generate', 'Generate Token')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('settings.apiTokens.scopeHint', 'admin > write > read. A read-only token cannot mutate, even if its owner is super_admin.')}
        </p>
      </Card>

      <Card padding="md">
        <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
          {t('settings.apiTokens.existing', 'Existing tokens')}
        </h3>
        {tokens && tokens.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
                  <th className="py-2 pr-3">{t('settings.apiTokens.name', 'Name')}</th>
                  <th className="py-2 pr-3">{t('settings.apiTokens.scopes', 'Scopes')}</th>
                  <th className="py-2 pr-3">{t('settings.apiTokens.preview', 'Preview')}</th>
                  <th className="py-2 pr-3">{t('settings.apiTokens.lastUsed', 'Last used')}</th>
                  <th className="py-2 pr-3">{t('settings.apiTokens.created', 'Created')}</th>
                  <th className="py-2 pr-3">{t('settings.apiTokens.status', 'Status')}</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => {
                  const revoked = !!token.revoked_at;
                  const expired = token.expires_at && new Date(token.expires_at) <= new Date();
                  const status = revoked
                    ? t('settings.apiTokens.statusRevoked', 'Revoked')
                    : expired
                      ? t('settings.apiTokens.statusExpired', 'Expired')
                      : t('settings.apiTokens.statusActive', 'Active');
                  return (
                    <tr key={token.id} className="border-b border-neutral-100 dark:border-neutral-800 last:border-0">
                      <td className="py-3 pr-3 font-medium">{token.name}</td>
                      <td className="py-3 pr-3 text-neutral-600 dark:text-neutral-400">{token.scopes}</td>
                      <td className="py-3 pr-3 font-mono text-xs text-neutral-500">
                        pp_live_{token.preview || '••••'}…
                      </td>
                      <td className="py-3 pr-3 text-neutral-500">
                        {token.last_used_at ? fmtDateTime(token.last_used_at) : '—'}
                      </td>
                      <td className="py-3 pr-3 text-neutral-500">
                        {fmtDate(token.created_at)}
                      </td>
                      <td className="py-3 pr-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          revoked || expired
                            ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400'
                            : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                        }`}>
                          {status}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        {!revoked && (
                          <Button
                            size="sm"
                            variant="ghost"
                            leftIcon={<Trash2 className="w-4 h-4" />}
                            onClick={() => {
                              if (confirm(t('settings.apiTokens.confirmRevoke', { name: token.name, defaultValue: `Revoke "${token.name}"? Existing integrations using this token will start getting 401.` }))) {
                                revokeMutation.mutate(token.id);
                              }
                            }}
                          >
                            {t('settings.apiTokens.revoke', 'Revoke')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('settings.apiTokens.empty', 'No tokens yet. Generate one above to get started.')}
          </p>
        )}
      </Card>
    </div>
  );
};
