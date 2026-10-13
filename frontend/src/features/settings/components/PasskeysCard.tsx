import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Fingerprint, Lock, Plus } from 'lucide-react';

import { Button, Card, ErrorState, Input, Loading, Notice } from '../../../components/common';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { PUBLIC_SETTINGS_QUERY_KEY } from '../../../hooks/usePublicSettings';
import { passkeyService, type Passkey } from '../../../services/passkey.service';
import { isPasskeySupported, passkeyErrorKind } from '../../../utils/webauthn';

// Passkeys for the admin's own account (issue 1733). Sits beside the
// two-factor card: a passkey signs in without the password and also stands in
// for the authenticator code. Self-service: acts on the signed-in admin only.

const QUERY_KEY = ['admin-passkeys'];

export const PasskeysCard: React.FC = () => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();

  const { data: status, isLoading, isError, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => passkeyService.getStatus(),
  });

  // With two-factor authentication on, adding a passkey takes a code as well:
  // a passkey signs in without one.
  const needsCode = status?.mfaEnabled === true;

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [removingId, setRemovingId] = useState<number | null>(null);
  const [removePassword, setRemovePassword] = useState('');
  const [removeError, setRemoveError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    // The login page offers a passkey only while one is registered.
    queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
  };

  // A dismissed browser prompt, a code the API names, or the API's own words.
  const errorText = (error: any, fallbackKey: string): string => {
    const kind = passkeyErrorKind(error);
    if (kind) return t(`settings.passkeys.errors.${kind}`);
    const data = error?.response?.data;
    if (data?.code === 'PASSKEY_LIMIT') return t('settings.passkeys.errors.limit');
    if (data?.code === 'PASSKEY_ALREADY_REGISTERED') return t('settings.passkeys.errors.exists');
    if (data?.code === 'PASSKEY_CHALLENGE_INVALID') return t('settings.passkeys.errors.expired');
    if (data?.code === 'PASSWORD_INCORRECT') return t('settings.passkeys.errors.wrongPassword');
    if (data?.code === 'MFA_INVALID' || data?.code === 'MFA_CODE_REQUIRED') return t('settings.passkeys.errors.wrongCode');
    return data?.error || t(fallbackKey);
  };

  const closeAdd = () => {
    setAdding(false);
    setName('');
    setPassword('');
    setCode('');
    setAddError(null);
  };

  const addMutation = useMutation({
    mutationFn: () => (needsCode
      ? passkeyService.register(name.trim(), password, code.trim())
      : passkeyService.register(name.trim(), password)),
    onSuccess: () => {
      toast.success(t('settings.passkeys.added'));
      closeAdd();
      invalidate();
    },
    onError: (error) => {
      setAddError(errorText(error, 'settings.passkeys.errors.failed'));
      // A code is spent by the attempt that used it, whatever came after.
      setCode('');
      // A browser that already holds this passkey means the list is stale.
      invalidate();
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, value }: { id: number; value: string }) => passkeyService.rename(id, value),
    onSuccess: () => {
      setRenamingId(null);
      invalidate();
    },
    onError: (error) => toast.error(errorText(error, 'settings.passkeys.errors.failed')),
  });

  const closeRemove = () => {
    setRemovingId(null);
    setRemovePassword('');
    setRemoveError(null);
  };

  const removeMutation = useMutation({
    mutationFn: (id: number) => passkeyService.remove(id, removePassword),
    onSuccess: () => {
      toast.success(t('settings.passkeys.removed'));
      closeRemove();
      invalidate();
    },
    onError: (error) => setRemoveError(errorText(error, 'settings.passkeys.errors.failed')),
  });

  // Why a new passkey cannot be added here, in the order a fix would follow:
  // the install's own configuration first, then this browser.
  const unavailable = (() => {
    if (!status) return null;
    if (status.reason) return status.reason;
    if (status.origin && status.origin !== window.location.origin) return 'origin_mismatch';
    if (!isPasskeySupported()) return 'unsupported';
    return null;
  })();
  const atLimit = !!status && status.passkeys.length >= status.max;
  // An account the identity provider owns has no local password to confirm with.
  const needsPassword = status?.reason !== 'sso_account';

  const submitAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setAddError(t('settings.passkeys.nameRequired')); return; }
    if (!password) { setAddError(t('settings.passkeys.passwordRequired')); return; }
    if (needsCode && !code.trim()) { setAddError(t('settings.passkeys.codeRequired')); return; }
    setAddError(null);
    addMutation.mutate();
  };

  const submitRemove = (e: React.FormEvent, passkey: Passkey) => {
    e.preventDefault();
    if (needsPassword && !removePassword) { setRemoveError(t('settings.passkeys.passwordRequired')); return; }
    setRemoveError(null);
    removeMutation.mutate(passkey.id);
  };

  return (
    <Card padding="md">
      <div className="flex items-center gap-2 mb-1">
        <Fingerprint className="w-5 h-5 text-body" />
        <h2 className="text-lg font-semibold text-heading">{t('settings.passkeys.title')}</h2>
      </div>
      <p className="text-sm text-soft mb-4">{t('settings.passkeys.description')}</p>

      {isLoading ? (
        <div className="py-8 flex justify-center">
          <Loading size="md" />
        </div>
      ) : isError || !status ? (
        <ErrorState size="inline" title={t('settings.passkeys.loadFailed')} onRetry={() => refetch()} />
      ) : (
        <div className="space-y-4">
          {unavailable ? (
            <Notice tone="info" size="sm">
              {t(`settings.passkeys.unavailable.${unavailable}`, { origin: status.origin ?? '' })}
            </Notice>
          ) : (
            <p className="text-xs text-muted">
              {t('settings.passkeys.domainNote', { domain: status.rpId })}
            </p>
          )}

          {status.passkeys.length === 0 ? (
            <p className="text-sm text-soft">{t('settings.passkeys.empty')}</p>
          ) : (
            <ul className="rounded-lg border border-line divide-y divide-line">
              {status.passkeys.map((passkey) => (
                <li key={passkey.id} className="p-3">
                  {renamingId === passkey.id ? (
                    <form
                      className="flex flex-wrap items-start gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (renameValue.trim()) renameMutation.mutate({ id: passkey.id, value: renameValue.trim() });
                      }}
                    >
                      <div className="flex-1 min-w-[12rem]">
                        <Input
                          aria-label={t('settings.passkeys.nameLabel')}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          maxLength={100}
                          autoFocus
                        />
                      </div>
                      <Button type="submit" variant="primary" size="sm" isLoading={renameMutation.isPending}>
                        {t('common.save')}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRenamingId(null)}>
                        {t('common.cancel')}
                      </Button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-heading truncate">{passkey.name}</p>
                        <p className="text-xs text-muted">
                          {t('settings.passkeys.addedOn', { date: format(passkey.createdAt) })}
                          {' · '}
                          {passkey.lastUsedAt
                            ? t('settings.passkeys.lastUsed', { date: format(passkey.lastUsedAt) })
                            : t('settings.passkeys.neverUsed')}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setRenamingId(passkey.id); setRenameValue(passkey.name); }}
                        >
                          {t('settings.passkeys.rename')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { closeRemove(); setRemovingId(passkey.id); }}
                        >
                          {t('settings.passkeys.remove')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {removingId === passkey.id && (
                    <form className="mt-3 space-y-3" onSubmit={(e) => submitRemove(e, passkey)}>
                      <p className="text-sm text-body">
                        {t('settings.passkeys.removeHelp', { name: passkey.name })}
                      </p>
                      {needsPassword && (
                        <Input
                          type="password"
                          aria-label={t('settings.passkeys.passwordLabel')}
                          placeholder={t('settings.passkeys.passwordLabel')}
                          value={removePassword}
                          onChange={(e) => { setRemovePassword(e.target.value); setRemoveError(null); }}
                          leftIcon={<Lock className="w-5 h-5 text-faint" />}
                          error={removeError || undefined}
                          autoComplete="current-password"
                          autoFocus
                        />
                      )}
                      {!needsPassword && removeError && (
                        <p className="text-sm text-danger-text">{removeError}</p>
                      )}
                      <div className="flex gap-2">
                        <Button type="submit" variant="danger" size="sm" isLoading={removeMutation.isPending}>
                          {t('settings.passkeys.removeConfirm')}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={closeRemove}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!unavailable && (adding ? (
            <form className="space-y-3 p-4 rounded-lg border border-line" onSubmit={submitAdd}>
              <div>
                <label htmlFor="passkey-name" className="block text-sm font-medium text-body mb-1">
                  {t('settings.passkeys.nameLabel')}
                </label>
                <Input
                  id="passkey-name"
                  value={name}
                  onChange={(e) => { setName(e.target.value); setAddError(null); }}
                  placeholder={t('settings.passkeys.namePlaceholder')}
                  maxLength={100}
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="passkey-password" className="block text-sm font-medium text-body mb-1">
                  {t('settings.passkeys.passwordLabel')}
                </label>
                <Input
                  id="passkey-password"
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setAddError(null); }}
                  leftIcon={<Lock className="w-5 h-5 text-faint" />}
                  autoComplete="current-password"
                />
                <p className="text-xs text-muted mt-1">{t('settings.passkeys.passwordHelp')}</p>
              </div>
              {needsCode && (
                <div>
                  <label htmlFor="passkey-code" className="block text-sm font-medium text-body mb-1">
                    {t('settings.passkeys.codeLabel')}
                  </label>
                  <Input
                    id="passkey-code"
                    value={code}
                    onChange={(e) => { setCode(e.target.value); setAddError(null); }}
                    placeholder={t('settings.mfa.codePlaceholder')}
                    autoComplete="one-time-code"
                  />
                  <p className="text-xs text-muted mt-1">{t('settings.passkeys.codeHelp')}</p>
                </div>
              )}
              {addError && <Notice tone="danger" size="sm">{addError}</Notice>}
              <div className="flex gap-2">
                <Button type="submit" variant="primary" isLoading={addMutation.isPending}>
                  {t('settings.passkeys.continue')}
                </Button>
                <Button type="button" variant="ghost" onClick={closeAdd}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : atLimit ? (
            <p className="text-xs text-muted">{t('settings.passkeys.errors.limit')}</p>
          ) : (
            <Button variant="outline" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setAdding(true)}>
              {t('settings.passkeys.add')}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
};
