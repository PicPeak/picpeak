import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Trash2, Copy } from 'lucide-react';
import {
  Button, Card, Input, Loading, useConfirm, Notice, Badge,
  Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell, EmptyState, ErrorState,
} from '../../../components/common';
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
  const confirm = useConfirm();
  const { formatDateTime: fmtDateTime, format: fmtDate } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Array<'read' | 'write' | 'admin'>>(['read']);
  const [justCreatedToken, setJustCreatedToken] = useState<string | null>(null);

  const { data: tokens, isLoading, isError, isFetching, refetch } = useQuery({
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
        {/* No tab title here — the Settings shell renders the section
            heading (icon + label + divider) for every tab that isn't in
            SettingsPage's TABS_WITH_OWN_HEADER, and repeating it stacked
            two identical H2s on top of each other (QA warning). */}
        <p className="text-sm text-soft mb-4">
          {t('settings.apiTokens.subtitle', 'Long-lived bearer tokens for the public /api/v1 surface — n8n integrations, custom apps, scripts. Tokens act as the admin user that minted them, intersected with the chosen scopes.')}
        </p>

        {justCreatedToken && (
          <Notice
            tone="warning"
            className="mb-4"
            title={t('settings.apiTokens.copyNow', 'Copy this token now — it will not be shown again.')}
          >
            <div className="mt-1 flex items-center gap-2">
              <code className="block flex-1 min-w-0 px-3 py-2 bg-shell border border-warning-line rounded text-xs font-mono break-all">
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
          </Notice>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-2">
          <div className="md:col-span-1">
            <label className="block text-sm font-medium text-body mb-1">
              {t('settings.apiTokens.name', 'Name')}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.apiTokens.namePlaceholder', 'e.g. n8n production')}
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-sm font-medium text-body mb-1">
              {t('settings.apiTokens.scopes', 'Scopes')}
            </label>
            <div className="flex gap-3 pt-2">
              {ALL_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-sm text-body">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={() => toggleScope(s)}
                    className="w-4 h-4 text-accent rounded focus:ring-accent"
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
        <p className="text-xs text-muted">
          {t('settings.apiTokens.scopeHint', 'admin > write > read. A read-only token cannot mutate, even if its owner is super_admin.')}
        </p>
      </Card>

      <Card padding="md">
        <h3 className="text-base font-semibold text-heading mb-3">
          {t('settings.apiTokens.existing', 'Existing tokens')}
        </h3>
        {isError && !tokens ? (
          <ErrorState
            title={t('settings.apiTokens.loadFailed', 'Could not load the API tokens')}
            onRetry={() => refetch()}
            retrying={isFetching}
            size="inline"
          />
        ) : tokens && tokens.length > 0 ? (
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>{t('settings.apiTokens.name', 'Name')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.apiTokens.scopes', 'Scopes')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.apiTokens.preview', 'Preview')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.apiTokens.lastUsed', 'Last used')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.apiTokens.created', 'Created')}</TableHeaderCell>
                <TableHeaderCell>{t('settings.apiTokens.status', 'Status')}</TableHeaderCell>
                <TableHeaderCell align="right"><span className="sr-only">{t('common.actions', 'Actions')}</span></TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {tokens.map((token) => {
                const revoked = !!token.revoked_at;
                const expired = token.expires_at && new Date(token.expires_at) <= new Date();
                const status = revoked
                  ? t('settings.apiTokens.statusRevoked', 'Revoked')
                  : expired
                    ? t('settings.apiTokens.statusExpired', 'Expired')
                    : t('settings.apiTokens.statusActive', 'Active');
                return (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium text-heading">{token.name}</TableCell>
                    <TableCell className="text-soft">{token.scopes}</TableCell>
                    <TableCell className="font-mono text-xs text-muted">
                      pp_live_{token.preview || '••••'}…
                    </TableCell>
                    <TableCell className="text-muted">
                      {token.last_used_at ? fmtDateTime(token.last_used_at) : '—'}
                    </TableCell>
                    <TableCell className="text-muted">
                      {fmtDate(token.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={revoked || expired ? 'neutral' : 'success'}>
                        {status}
                      </Badge>
                    </TableCell>
                    <TableCell align="right">
                      {!revoked && (
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<Trash2 className="w-4 h-4" />}
                          onClick={async () => {
                            if (!(await confirm({
                              message: t('settings.apiTokens.confirmRevoke', { name: token.name, defaultValue: `Revoke "${token.name}"? Existing integrations using this token will start getting 401.` }),
                              variant: 'danger',
                              confirmLabel: t('settings.apiTokens.revokeAction', 'Revoke token'),
                            }))) return;
                            revokeMutation.mutate(token.id);
                          }}
                        >
                          {t('settings.apiTokens.revoke', 'Revoke')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            title={t('settings.apiTokens.empty', 'No tokens yet. Generate one above to get started.')}
            size="inline"
          />
        )}
      </Card>
    </div>
  );
};
