/**
 * Curated selection and full link (issue 2356), in the Photo source section.
 *
 * The admin names a subfolder of the saved external folder. Guests of the
 * ordinary link and QR code then see the photos in that subfolder only; the
 * full link shows every photo of the folder (the gallery password still
 * applies), and so does the client login. The changes act at once, like the
 * import button above: the server re-marks the photos when the folder changes.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Link2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import type { Event } from '../../../../types';
import { Button, Input, useConfirm } from '../../../../components/common';
import { eventsService, type SelectionState } from '../../../../services/events.service';
import { labelClass } from './sections';

export const SelectionPanel: React.FC<{ event: Event; canEdit: boolean }> = ({ event, canEdit }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [state, setState] = useState<SelectionState | null>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    eventsService.getSelection(event.id)
      .then((next) => {
        if (!live) return;
        setState(next);
        setFolder(next.selection_path || '');
      })
      .catch(() => { /* older server or no permission: no panel */ });
    return () => { live = false; };
  }, [event.id]);

  if (!state || !state.available) return null;

  const run = async (action: () => Promise<SelectionState>, done: string) => {
    setBusy(true);
    try {
      const next = await action();
      setState(next);
      setFolder(next.selection_path || '');
      // The event (its selection_path drives the Photos tab filter) and the
      // photo list (each photo's flag) changed.
      queryClient.invalidateQueries({ queryKey: ['admin-event'] });
      queryClient.invalidateQueries({ queryKey: ['admin-event-photos'] });
      toast.success(done);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('common.saveFailed', 'Save failed'));
    } finally {
      setBusy(false);
    }
  };

  const saveFolder = () => run(
    () => eventsService.setSelection(event.id, folder.trim() || null),
    t('events.selection.saved', 'Selection updated'),
  );

  const rotate = async () => {
    if (state.full_link_url && !await confirm({
      message: t('events.selection.rotateConfirm', 'Create a new full link? The current one stops working, and everyone who opened it has to use the new one.'),
      confirmLabel: t('events.selection.rotate', 'New link'),
    })) return;
    await run(() => eventsService.createFullLink(event.id), t('events.selection.linkCreated', 'Full link created'));
  };

  const remove = async () => {
    if (!await confirm({
      message: t('events.selection.removeConfirm', 'Remove the full link? Everyone who opened it is back to the selection.'),
      variant: 'danger',
      confirmLabel: t('events.selection.remove', 'Remove'),
    })) return;
    await run(() => eventsService.removeFullLink(event.id), t('events.selection.linkRemoved', 'Full link removed'));
  };

  const copy = async () => {
    if (!state.full_link_url) return;
    try {
      await navigator.clipboard.writeText(state.full_link_url);
      toast.success(t('common.copied', 'Copied'));
    } catch {
      toast.error(t('common.copyFailed', 'Copy failed'));
    }
  };

  const unchanged = folder.trim() === (state.selection_path || '');

  return (
    <div className="space-y-3 pt-4 border-t border-line">
      <div>
        <h4 className="text-sm font-semibold text-heading">{t('events.selection.title', 'Selection for guests')}</h4>
        <p className="text-xs text-soft mt-1">
          {t('events.selection.help', 'Name a subfolder of this folder, for example "gallery". The gallery link and its QR code then show only the photos in that subfolder. The full link and the client login show every photo of the folder.')}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 basis-56 min-w-0">
          <label className={labelClass} htmlFor="settings-selection-folder">
            {t('events.selection.folder', 'Selection subfolder')}
          </label>
          <Input
            id="settings-selection-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={t('events.selection.folderPlaceholder', 'No selection: guests see every photo') as string}
            disabled={!canEdit || busy}
          />
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={saveFolder} disabled={busy || unchanged}>
            {t('events.selection.save', 'Apply')}
          </Button>
        )}
      </div>
      {state.selection_path && (
        <p className="text-xs text-body" role="status">
          {t('events.selection.counts', '{{inside}} photos in the selection, {{outside}} only in the full view', {
            inside: state.in_selection, outside: state.outside_selection,
          })}
        </p>
      )}
      {state.selection_path && (
        <div className="rounded-lg bg-accent-dark/10 px-3 py-2 space-y-2">
          <p className="text-xs text-body flex items-center gap-1.5">
            <Link2 className="w-4 h-4 shrink-0" aria-hidden />
            {t('events.selection.fullLinkHelp', 'The full link opens this gallery with every photo. Share it only with the people who should see them all.')}
          </p>
          {state.full_link_url ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input readOnly value={state.full_link_url} aria-label={t('events.selection.fullLink', 'Full link') as string} className="flex-1 basis-64 min-w-0 text-xs" />
              <Button variant="outline" size="sm" leftIcon={<Copy className="w-4 h-4" />} onClick={copy}>
                {t('common.copy', 'Copy')}
              </Button>
              {canEdit && (
                <>
                  <Button variant="outline" size="sm" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={rotate} disabled={busy}>
                    {t('events.selection.rotate', 'New link')}
                  </Button>
                  <Button variant="ghost" size="sm" leftIcon={<Trash2 className="w-4 h-4" />} onClick={remove} disabled={busy}>
                    {t('events.selection.remove', 'Remove')}
                  </Button>
                </>
              )}
            </div>
          ) : canEdit && (
            <Button variant="outline" size="sm" leftIcon={<Link2 className="w-4 h-4" />} onClick={rotate} disabled={busy}>
              {t('events.selection.createLink', 'Create full link')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
