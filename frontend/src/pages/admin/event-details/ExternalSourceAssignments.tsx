import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import { externalMediaService } from '../../../services/externalMedia.service';

export const ExternalSourceAssignments: React.FC<{ selectedPath: string }> = ({ selectedPath }) => {
  const { t } = useTranslation();
  const { user } = useAdminAuth();
  const client = useQueryClient();
  const [owner, setOwner] = useState('');
  const [error, setError] = useState(false);
  const { data } = useQuery({
    queryKey: ['external-sources', user?.id],
    queryFn: () => externalMediaService.getSources(),
  });
  const refresh = async () => {
    setError(false);
    await Promise.all([
      client.invalidateQueries({ queryKey: ['external-sources'] }),
      client.invalidateQueries({ queryKey: ['external-folder-children'] }),
    ]);
  };
  const assign = useMutation({
    mutationFn: () => externalMediaService.assignSource(selectedPath, Number(owner)),
    onSuccess: refresh,
    onError: () => setError(true),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => externalMediaService.revokeSource(id),
    onSuccess: refresh,
    onError: () => setError(true),
  });
  if (!data) return null;
  if (!data.can_assign) {
    return data.sources.length === 0
      ? <p className="mt-2 text-sm text-muted">{t('externalSources.noSources')}</p>
      : null;
  }
  const busy = assign.isPending || revoke.isPending;
  return (
    <fieldset className="mt-3 border-t border-line pt-3 text-sm">
      <legend className="font-medium text-heading">{t('externalSources.title')}</legend>
      <p className="mb-2 text-muted">{t('externalSources.info')}</p>
      <label className="block" htmlFor="external-source-owner">{t('externalSources.owner')}</label>
      <div className="flex flex-wrap gap-2">
        <select id="external-source-owner" value={owner} onChange={(e) => setOwner(e.target.value)}
          className="border border-line rounded p-1 bg-panel text-body" disabled={busy}>
          <option value="">{t('externalSources.chooseOwner')}</option>
          {data.owners.map((account) => <option key={account.id} value={account.id}>{account.username}</option>)}
        </select>
        <button type="button" className="underline text-accent-dark" disabled={!selectedPath || !owner || busy}
          onClick={() => assign.mutate()}>{t('externalSources.assign')}</button>
      </div>
      {error && <p role="alert" className="mt-2 text-body">{t('externalSources.error')}</p>}
      <ul className="mt-2 space-y-1">
        {data.sources.map((source) => (
          <li key={source.id} className="flex flex-wrap justify-between gap-2">
            <span>{source.path} — {data.owners.find((account) => account.id === source.owner_id)?.username ?? t('externalSources.unassigned')}</span>
            <button type="button" className="underline text-body" disabled={busy}
              onClick={() => {
                if (window.confirm(t('externalSources.confirmRevoke', { path: source.path }))) revoke.mutate(source.id);
              }}>{t('externalSources.revoke')}</button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
};
