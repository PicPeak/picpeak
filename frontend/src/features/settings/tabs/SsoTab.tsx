import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save, KeyRound, PlugZap, Copy, Check, UserCog, ShieldAlert, Plus, Trash2 } from 'lucide-react';
import type { AxiosError } from 'axios';

import { Button, Card, Input, Loading } from '../../../components/common';
import { ssoService, SsoSettings, UpdateSsoSettings } from '../../../services/sso.service';

interface MappingRow {
  idpRole: string;
  role: string;
}

// The four system roles — same hardcoded set the default-role select uses.
// The backend re-validates every mapping target against the roles table.
const ROLE_OPTIONS: Record<string, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  admin: 'Admin',
  super_admin: 'Super Admin',
};

// SSO (OIDC) settings (#798). Phase 1: issuer + client credentials, JIT
// toggle with default role, button label. Phase 2: role-claim mapping and
// login policy (require mapped role / disable local login). The client
// secret is write-only — the field stays blank and only overwrites when the
// admin types a new value.
export const SsoTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<SsoSettings | null>(null);
  // Row-based editor state for the { idpRole: picpeakRole } mapping object —
  // an object can't represent a half-typed key, rows can.
  const [mappingRows, setMappingRows] = useState<MappingRow[] | null>(null);
  const [newSecret, setNewSecret] = useState('');
  const [copied, setCopied] = useState(false);

  const { isLoading } = useQuery({
    queryKey: ['admin-sso-settings'],
    queryFn: async () => {
      const settings = await ssoService.getSettings();
      setForm((prev) => prev ?? settings);
      setMappingRows((prev) => prev
        ?? Object.entries(settings.oidc_role_mappings || {}).map(([idpRole, role]) => ({ idpRole, role })));
      return settings;
    },
  });

  const saveMutation = useMutation({
    mutationFn: (data: UpdateSsoSettings) => ssoService.updateSettings(data),
    onSuccess: () => {
      toast.success(t('settings.sso.saved', 'SSO settings saved'));
      setNewSecret('');
      setForm(null); // re-init from the fresh GET (secret_set flag updates)
      setMappingRows(null);
      queryClient.invalidateQueries({ queryKey: ['admin-sso-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    },
    onError: (error: AxiosError<{ error?: string }>) => {
      toast.error(error.response?.data?.error || t('settings.sso.saveError', 'Failed to save SSO settings'));
    },
  });

  const testMutation = useMutation({
    mutationFn: () => ssoService.testConnection(),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(t('settings.sso.testOk', 'Discovery succeeded — issuer is reachable: {{issuer}}', { issuer: result.issuer }));
      } else {
        toast.error(result.error || t('settings.sso.testFailed', 'Discovery failed'));
      }
    },
    onError: (error: AxiosError<{ error?: string }>) => {
      toast.error(error.response?.data?.error || t('settings.sso.testFailed', 'Discovery failed'));
    },
  });

  if (isLoading || !form || !mappingRows) {
    return <Loading />;
  }

  const set = <K extends keyof SsoSettings>(key: K, value: SsoSettings[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const setRow = (index: number, patch: Partial<MappingRow>) =>
    setMappingRows((prev) => (prev ? prev.map((row, i) => (i === index ? { ...row, ...patch } : row)) : prev));

  const handleSave = () => {
    const payload: UpdateSsoSettings = {
      oidc_enabled: form.oidc_enabled,
      oidc_issuer_url: form.oidc_issuer_url.trim(),
      oidc_client_id: form.oidc_client_id.trim(),
      oidc_autoprovision: form.oidc_autoprovision,
      oidc_default_role: form.oidc_default_role,
      oidc_button_label: form.oidc_button_label.trim(),
      oidc_scopes: form.oidc_scopes.trim(),
      oidc_role_mapping_enabled: form.oidc_role_mapping_enabled,
      oidc_roles_claim: form.oidc_roles_claim.trim(),
      oidc_role_mappings: Object.fromEntries(
        mappingRows.filter((row) => row.idpRole.trim()).map((row) => [row.idpRole.trim(), row.role])
      ),
      oidc_require_mapped_role: form.oidc_require_mapped_role,
      // Turning SSO off must clear the policy in the same save — the backend
      // (rightly) rejects an explicit true while SSO is off, and the promise
      // is that disabling SSO restores password login.
      oidc_disable_local_login: form.oidc_enabled ? form.oidc_disable_local_login : false,
      oidc_logout_from_idp: form.oidc_enabled ? form.oidc_logout_from_idp : false,
    };
    if (newSecret.trim()) payload.oidc_client_secret = newSecret.trim();
    saveMutation.mutate(payload);
  };

  const copyRedirectUri = async () => {
    try {
      await navigator.clipboard.writeText(form.redirect_uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the URI is visible to copy by hand.
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-neutral-500" />
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('settings.sso.title', 'Single Sign-On (OIDC)')}
            </h2>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('settings.sso.intro', 'Let admins sign in through your identity provider (Keycloak, Authentik, Pocket ID, or any OIDC-compliant IdP). Local email/password login stays available as a fallback.')}
          </p>

          {/* Redirect URI for the IdP client registration */}
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 p-3">
            <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              {t('settings.sso.redirectUri', 'Redirect URI (register this on your IdP client)')}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100">
                {form.redirect_uri}
              </code>
              <button
                type="button"
                onClick={copyRedirectUri}
                className="flex-shrink-0 rounded-md border border-neutral-200 dark:border-neutral-600 bg-white dark:bg-neutral-700 p-2 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 transition-colors"
                aria-label={t('common.copy', 'Copy')}
                title={t('common.copy', 'Copy')}
              >
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <Input
            label={t('settings.sso.issuerUrl', 'Issuer URL')}
            placeholder="https://id.example.com/realms/main"
            value={form.oidc_issuer_url}
            onChange={(e) => set('oidc_issuer_url', e.target.value)}
          />
          <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.sso.issuerHint', 'The base URL that serves /.well-known/openid-configuration.')}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t('settings.sso.clientId', 'Client ID')}
              value={form.oidc_client_id}
              onChange={(e) => set('oidc_client_id', e.target.value)}
            />
            <div>
              <Input
                label={t('settings.sso.clientSecret', 'Client Secret')}
                type="password"
                autoComplete="new-password"
                placeholder={form.oidc_client_secret_set
                  ? t('settings.sso.secretSetPlaceholder', '•••••• (saved — type to replace)')
                  : t('settings.sso.secretUnsetPlaceholder', 'Paste the client secret')}
                value={newSecret}
                onChange={(e) => setNewSecret(e.target.value)}
              />
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.secretHint', 'Stored encrypted; never shown again. Leave blank to keep the current one.')}
              </p>
            </div>
          </div>

          <Input
            label={t('settings.sso.scopes', 'Scopes')}
            value={form.oidc_scopes}
            onChange={(e) => set('oidc_scopes', e.target.value)}
          />

          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              checked={form.oidc_autoprovision}
              onChange={(e) => set('oidc_autoprovision', e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t('settings.sso.autoprovision', 'Auto-provision unknown users')}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.autoprovisionHint', 'Create an admin account on first SSO login. Off: only existing/linked admins can sign in.')}
              </span>
            </span>
          </label>

          {form.oidc_autoprovision && (
            <div className="max-w-xs">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.sso.defaultRole', 'Role for new users')}
              </label>
              <select
                value={form.oidc_default_role}
                onChange={(e) => set('oidc_default_role', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
              >
                <option value="viewer">{t('users.roles.viewer', 'Viewer')}</option>
                <option value="editor">{t('users.roles.editor', 'Editor')}</option>
                <option value="admin">{t('users.roles.admin', 'Admin')}</option>
                <option value="super_admin">{t('users.roles.super_admin', 'Super Admin')}</option>
              </select>
            </div>
          )}

          <Input
            label={t('settings.sso.buttonLabel', 'Login button label (optional)')}
            placeholder={t('settings.sso.buttonLabelPlaceholder', 'Sign in with SSO')}
            value={form.oidc_button_label}
            onChange={(e) => set('oidc_button_label', e.target.value)}
          />

          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              checked={form.oidc_enabled}
              onChange={(e) => set('oidc_enabled', e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t('settings.sso.enabled', 'Enable SSO login')}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.enabledHint', 'Shows the SSO button on the admin login page. Requires issuer, client ID and secret.')}
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <Button
              variant="primary"
              leftIcon={<Save className="w-4 h-4" />}
              onClick={handleSave}
              isLoading={saveMutation.isPending}
            >
              {t('common.save', 'Save')}
            </Button>
            <Button
              variant="outline"
              leftIcon={<PlugZap className="w-4 h-4" />}
              onClick={() => testMutation.mutate()}
              isLoading={testMutation.isPending}
            >
              {t('settings.sso.test', 'Test connection')}
            </Button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.sso.testHint', 'Test runs OIDC discovery against the saved configuration — save first.')}
          </p>
        </div>
      </Card>

      {/* Role mapping (#798 phase 2) */}
      <Card>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <UserCog className="w-5 h-5 text-neutral-500" />
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('settings.sso.roleMapping.title', 'Role mapping')}
            </h2>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('settings.sso.roleMapping.intro', 'Assign PicPeak roles from a role or group claim in the ID token. Roles are re-evaluated on every SSO login — the IdP becomes the source of truth.')}
          </p>

          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              checked={form.oidc_role_mapping_enabled}
              onChange={(e) => set('oidc_role_mapping_enabled', e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t('settings.sso.roleMapping.enabled', 'Enable role mapping')}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.roleMapping.enabledHint', 'Off: existing admins keep their role and new users get the default role above.')}
              </span>
            </span>
          </label>

          {form.oidc_role_mapping_enabled && (
            <>
              <div className="max-w-md">
                <Input
                  label={t('settings.sso.roleMapping.claim', 'Roles claim (dot-path)')}
                  placeholder="realm_access.roles"
                  value={form.oidc_roles_claim}
                  onChange={(e) => set('oidc_roles_claim', e.target.value)}
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('settings.sso.roleMapping.claimHint', 'Keycloak: realm_access.roles · Authentik: groups · Entra ID: roles or groups')}
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {t('settings.sso.roleMapping.mappings', 'Mappings (IdP value → PicPeak role)')}
                </p>
                {mappingRows.length === 0 && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t('settings.sso.roleMapping.noMappings', 'No mappings yet — without one, no login gets a role from the IdP.')}
                  </p>
                )}
                {mappingRows.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <Input
                        placeholder={t('settings.sso.roleMapping.idpValuePlaceholder', 'IdP role or group, e.g. picpeak-admins')}
                        value={row.idpRole}
                        onChange={(e) => setRow(index, { idpRole: e.target.value })}
                      />
                    </div>
                    <select
                      value={row.role}
                      onChange={(e) => setRow(index, { role: e.target.value })}
                      className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                    >
                      {Object.entries(ROLE_OPTIONS).map(([role, label]) => (
                        <option key={role} value={role}>{t(`users.roles.${role}`, label)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setMappingRows((prev) => (prev ? prev.filter((_, i) => i !== index) : prev))}
                      className="flex-shrink-0 rounded-md p-2 text-neutral-400 hover:text-red-600 transition-colors"
                      aria-label={t('common.delete', 'Delete')}
                      title={t('common.delete', 'Delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Plus className="w-4 h-4" />}
                  onClick={() => setMappingRows((prev) => [...(prev || []), { idpRole: '', role: 'viewer' }])}
                >
                  {t('settings.sso.roleMapping.addMapping', 'Add mapping')}
                </Button>
              </div>

              <label className="flex items-start gap-3 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                  checked={form.oidc_require_mapped_role}
                  onChange={(e) => set('oidc_require_mapped_role', e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                    {t('settings.sso.roleMapping.requireRole', 'Require a mapped role to sign in')}
                  </span>
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                    {t('settings.sso.roleMapping.requireRoleHint', 'Refuse SSO logins whose token maps to no role — only members of the mapped IdP groups get in. The last active Super Admin is never demoted by mapping.')}
                  </span>
                </span>
              </label>
            </>
          )}
        </div>
      </Card>

      {/* Login policy (#798 phase 2) */}
      <Card>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-neutral-500" />
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('settings.sso.policy.title', 'Login policy')}
            </h2>
          </div>

          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              checked={form.oidc_disable_local_login}
              onChange={(e) => set('oidc_disable_local_login', e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t('settings.sso.policy.disableLocalLogin', 'Disable local password login')}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.policy.disableLocalLoginHint', 'The login page shows only the SSO button and the API refuses password logins. Only possible while SSO is enabled; turning SSO off restores password login automatically.')}
              </span>
            </span>
          </label>

          {form.oidc_disable_local_login && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-300">
              {t('settings.sso.policy.breakGlassHint', 'Locked out because the IdP is down or misconfigured? Set the environment variable OIDC_BREAK_GLASS=true on the backend and restart — password login comes back immediately.')}
            </div>
          )}

          {/* Logout-to-IdP (#798 phase 3) */}
          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              checked={form.oidc_logout_from_idp}
              onChange={(e) => set('oidc_logout_from_idp', e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t('settings.sso.policy.logoutFromIdp', 'Also sign out of the identity provider')}
              </span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.sso.policy.logoutFromIdpHint', 'Logging out of PicPeak also ends the IdP session (RP-initiated logout). Only applies to sessions that signed in via SSO; without this, logging out of PicPeak leaves the IdP session alive and the next SSO click signs straight back in.')}
              </span>
            </span>
          </label>

          {form.oidc_logout_from_idp && form.post_logout_redirect_uri && (
            <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/60 p-3">
              <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1">
                {t('settings.sso.policy.postLogoutRedirectUri', 'Post-logout redirect URI (register this on your IdP client, e.g. Keycloak "Valid post logout redirect URIs")')}
              </p>
              <code className="block text-xs text-neutral-800 dark:text-neutral-200 break-all">
                {form.post_logout_redirect_uri}
              </code>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

SsoTab.displayName = 'SsoTab';
