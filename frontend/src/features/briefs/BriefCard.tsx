/**
 * The brief of a project or of a customer without one (issue 2678): the
 * template's fields, filled in by the studio, each with its customer
 * visibility, the shared arrangements, and "Notify customer", which sends
 * every visible change since the last update in one mail and shows it in
 * the portal.
 *
 * `useBriefEditor` owns the query and the draft; the page decides how the
 * draft is saved (the cockpit through its save bar, the customer page with
 * the card's own buttons). Notify is an action, never behind a save.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Send, Trash2 } from 'lucide-react';
import { Button, Card, ErrorState, Input, LocalizedDateInput, Skeleton, TimeField, useConfirm } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../hooks';
import { eventTypesService } from '../../services/eventTypes.service';
import { briefsService, type BriefField, type BriefOwner, type BriefPlace } from '../../services/briefs.service';
import { settingsTabHref } from '../settings/settingsNav';
import { briefLabel, useBriefValueText } from './briefFields';
import { briefPayload, draftFromBrief, rebaseBriefDraft, type BriefDraft, type BriefDraftValue } from './briefDraft';

export function useBriefEditor(owner: BriefOwner, { enabled = true }: { enabled?: boolean } = {}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const queryKey = useMemo(() => ['brief', owner.kind, owner.id], [owner.kind, owner.id]);
  const query = useQuery({ queryKey, queryFn: () => briefsService.get(owner), enabled });
  const brief = query.data;
  const withOccasion = owner.kind === 'customers';

  const base = useMemo(() => draftFromBrief(brief), [brief]);
  // The draft is held with the owner and the saved brief it was made from: a
  // draft of another project or customer (the page stayed mounted) is
  // dropped, one made from an older saved brief is rebased (UX.md › rebaseDraft).
  const ownerKey = `${owner.kind}:${owner.id}`;
  const [held, setHeld] = useState({ ownerKey, base, draft: base });
  const resolve = (h: typeof held): BriefDraft => {
    if (h.ownerKey !== ownerKey) return base;
    return h.base === base ? h.draft : rebaseBriefDraft(h.draft, h.base, base);
  };
  const draft = resolve(held);
  const setDraft = (update: (d: BriefDraft) => BriefDraft) => setHeld((h) => ({ ownerKey, base, draft: update(resolve(h)) }));

  const payload = briefPayload(draft, base, brief, withOccasion);
  const dirty = Object.keys(payload).length > 0;

  const save = useMutationWithToast({
    mutationFn: async () => {
      const sent = draft;
      return { sent, saved: await briefsService.save(owner, payload) };
    },
    successMessage: t('briefs.saved', 'Brief saved') as string,
    errorMessage: t('briefs.saveFailed', 'Could not save the brief') as string,
    // The saved brief becomes the baseline; what was typed while the request
    // ran (anything that differs from what was sent) stays a local edit.
    onSuccess: ({ sent, saved }) => {
      const savedBase = draftFromBrief(saved);
      setHeld((h) => ({ ownerKey, base: savedBase, draft: { ...rebaseBriefDraft(resolve(h), sent, savedBase), cleared: [] } }));
      qc.setQueryData(queryKey, saved);
    },
  });
  const notify = useMutationWithToast({
    mutationFn: () => briefsService.notify(owner),
    // A customer who takes no administrative email gets none; the portal
    // shows the update all the same (as with their other held-back notices).
    successMessage: (r) => (r.mail === 'suppressed'
      ? t('briefs.notify.suppressed', 'Portal updated. The customer takes no administrative email, so no email was sent.')
      : t('briefs.notify.sent', 'Update queued to the customer.')) as string,
    errorMessage: t('briefs.notify.failed', 'Could not send the update') as string,
    invalidateKeys: [queryKey],
  });

  return {
    owner, query, brief, draft, setDraft, dirty, save, notify,
    discard: () => setDraft(() => base),
  };
}

export type BriefEditor = ReturnType<typeof useBriefEditor>;

export const BriefCard: React.FC<{
  editor: BriefEditor;
  canEdit: boolean;
  footer?: React.ReactNode;
  /** Other unsaved or saving edits on the page that the update would carry
   *  (the project data on the cockpit). */
  pageBusy?: boolean;
}> = ({ editor, canEdit, footer, pageBusy = false }) => {
  const { t, i18n } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const valueText = useBriefValueText();
  const confirm = useConfirm();
  const { owner, query, brief, draft, setDraft, dirty, save, notify } = editor;
  const isCustomerBrief = owner.kind === 'customers';
  const { data: occasions = [] } = useQuery({
    queryKey: ['event-types', 'active'],
    queryFn: () => eventTypesService.getActiveEventTypes(),
    enabled: isCustomerBrief,
  });

  const title = (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
      <h2 className="text-base font-semibold text-heading">{t('briefs.title', 'Brief')}</h2>
      {dirty && (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning-text">
          <span className="w-2 h-2 rounded-full bg-warning" aria-hidden />
          {t('briefs.notSaved', 'not saved yet')}
        </span>
      )}
    </div>
  );

  if (!brief) {
    return (
      <Card>
        {title}
        {query.isError
          ? <ErrorState title={t('briefs.loadFailed', 'Could not load the brief.')} onRetry={() => { void query.refetch(); }} />
          : <Skeleton className="h-24 w-full" />}
      </Card>
    );
  }

  const label = (field: { label: string; labels?: Partial<Record<string, string>> }) => briefLabel(field, i18n.language);
  const fields = brief.fields.filter((f) => f.source !== 'removed');
  const removed = brief.fields.filter((f) => f.source === 'removed' && !draft.cleared.includes(f.id));
  const setValue = (id: number, value: BriefDraftValue) => setDraft((d) => ({ ...d, values: { ...d.values, [id]: value } }));
  const toggleVisible = (field: BriefField) => {
    const shown = draft.visible[field.id] ?? field.visibleDefault;
    // Back to the template's choice is "follow the template" (null), so a
    // later template change still reaches this brief (UX.md › Forms).
    const next = !shown === field.visibleDefault ? null : !shown;
    setDraft((d) => ({ ...d, visible: { ...d.visible, [field.id]: next } }));
  };
  const pending = brief.pendingChanges.length;
  const notifyBlocked = !brief.hasCustomer
    ? t('briefs.notify.noCustomer', 'Link a customer to the project to send updates.')
    : dirty || save.isPending || pageBusy ? t('briefs.notify.saveFirst', 'Save your changes first.') : null;

  const sendUpdate = async () => {
    const ok = await confirm({
      title: t('briefs.notify.confirmTitle', 'Notify customer'),
      message: t('briefs.notify.confirmMessage', 'Email the customer the changes since the last update ({{count}})? They also see the new state in their portal.', { count: pending }),
      confirmLabel: t('briefs.notify.button', 'Notify customer'),
    });
    if (ok) notify.mutate();
  };

  return (
    <Card>
      {title}
      <p className="text-xs text-muted mb-4">
        {t('briefs.help', 'The agreed details of this job. The customer sees the fields marked with an eye once you notify them.')}
      </p>
      {!canEdit && <p className="text-xs text-muted mb-3">{t('briefs.readOnly', 'You can see this brief but not change it.')}</p>}

      <fieldset disabled={!canEdit} className="space-y-4">
        {isCustomerBrief && (
          <div>
            <label htmlFor="brief-occasion" className="block text-sm font-medium text-body mb-1">{t('briefs.occasion', 'Occasion')}</label>
            <select
              id="brief-occasion"
              value={draft.occasion ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, occasion: e.target.value || null }))}
              className="input w-full"
            >
              <option value="">{t('briefs.noOccasion', 'None (only the fields for every occasion)')}</option>
              {occasions.map((o) => <option key={o.slug_prefix} value={o.slug_prefix}>{o.name}</option>)}
            </select>
            {draft.occasion !== brief.occasion && (
              <p className="text-xs text-muted mt-1">{t('briefs.occasionAfterSave', 'The fields of the new occasion appear after saving.')}</p>
            )}
          </div>
        )}

        {fields.length === 0 ? (
          <p className="text-sm text-muted">
            {t('briefs.noFields', 'No brief fields for this occasion yet.')}{' '}
            <Link to={settingsTabHref('briefTemplates')} className="text-accent hover:underline">{t('briefs.setUpTemplates', 'Set up brief templates')}</Link>
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {fields.map((field) => {
              const shown = draft.visible[field.id] ?? field.visibleDefault;
              const wide = ['long_text', 'place', 'place_time'].includes(field.type);
              return (
                <div key={field.id} className={wide ? 'md:col-span-2' : undefined}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label htmlFor={`brief-field-${field.id}`} className="text-sm font-medium text-body">{label(field)}</label>
                    <button
                      type="button"
                      onClick={() => toggleVisible(field)}
                      className={`inline-flex items-center gap-1 text-xs ${shown ? 'text-body' : 'text-faint'} hover:text-heading`}
                      aria-pressed={shown}
                      title={draft.visible[field.id] != null ? t('briefs.visibilityOverride', 'Differs from the template') : undefined}
                    >
                      {shown ? <Eye className="w-3.5 h-3.5" aria-hidden /> : <EyeOff className="w-3.5 h-3.5" aria-hidden />}
                      {shown ? t('briefs.visible', 'Customer sees it') : t('briefs.hidden', 'Hidden')}
                      {draft.visible[field.id] != null && <span className="w-1.5 h-1.5 rounded-full bg-accent-strong" aria-hidden />}
                    </button>
                  </div>
                  {field.fromProject ? (
                    <>
                      <p id={`brief-field-${field.id}`} className="text-sm text-heading">{valueText(field.type, field.value) || '—'}</p>
                      <p className="text-xs text-muted mt-0.5">{t('briefs.fromProject', 'From the project data')}</p>
                    </>
                  ) : (
                    <BriefInput field={field} value={draft.values[field.id] ?? null} onChange={(v) => setValue(field.id, v)} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div>
          <label htmlFor="brief-shared" className="block text-sm font-medium text-body mb-1">{t('briefs.shared', 'Shared arrangements')}</label>
          <textarea
            id="brief-shared"
            value={draft.sharedArrangements}
            onChange={(e) => setDraft((d) => ({ ...d, sharedArrangements: e.target.value }))}
            rows={4}
            maxLength={10000}
            className="input w-full"
          />
          <p className="text-xs text-muted mt-1">{t('briefs.sharedHint', 'The customer sees this text. Internal notes stay in the notes field.')}</p>
        </div>
      </fieldset>

      {removed.length > 0 && (
        <div className="mt-4 border-t border-line pt-4">
          <h3 className="text-sm font-medium text-heading mb-1">{t('briefs.removed', 'No longer in the template')}</h3>
          <p className="text-xs text-muted mb-2">{t('briefs.removedHint', 'Kept on this brief and never shown to the customer.')}</p>
          <ul className="divide-y divide-line-faint">
            {removed.map((field) => (
              <li key={field.id} className="py-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted">{field.label}</p>
                  <p className="text-sm text-heading break-words">{valueText(field.type, field.value)}</p>
                </div>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Trash2 className="w-4 h-4" />}
                    onClick={() => setDraft((d) => ({ ...d, cleared: [...d.cleared, field.id] }))}
                  >
                    {t('briefs.removeValue', 'Remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 border-t border-line pt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm min-w-0">
          <p className={pending ? 'text-warning-text font-medium' : 'text-muted'}>
            {pending
              ? t('briefs.notify.pending', 'Changes not sent yet: {{count}}', { count: pending })
              : t('briefs.notify.upToDate', 'The customer has the current state.')}
          </p>
          {brief.notifiedAt && (
            <p className="text-xs text-muted">{t('briefs.notify.last', 'Last update sent {{date}}', { date: formatDateTime(brief.notifiedAt) })}</p>
          )}
          {canEdit && pending > 0 && notifyBlocked && <p className="text-xs text-muted">{notifyBlocked}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {footer}
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Send className="w-4 h-4" />}
              disabled={pending === 0 || !!notifyBlocked}
              isLoading={notify.isPending}
              onClick={() => { void sendUpdate(); }}
            >
              {t('briefs.notify.button', 'Notify customer')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};

const BriefInput: React.FC<{ field: BriefField; value: BriefDraftValue; onChange: (value: BriefDraftValue) => void }> = ({ field, value, onChange }) => {
  const { t } = useTranslation();
  const id = `brief-field-${field.id}`;
  switch (field.type) {
    case 'long_text':
      return <textarea id={id} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={5000} className="input w-full" />;
    case 'date':
    case 'project_date':
      return <LocalizedDateInput ariaLabel={field.label} value={(value as string) ?? ''} onChange={onChange} />;
    case 'time':
      return <TimeField ariaLabel={field.label} value={(value as string) ?? ''} onChange={onChange} allowEmpty />;
    case 'datetime': {
      const [day = '', time = ''] = ((value as string) || '').split('T');
      const join = (d: string, h: string) => onChange(d || h ? `${d}T${h}` : '');
      return (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <LocalizedDateInput ariaLabel={field.label} value={day} onChange={(d) => join(d, time)} />
          <TimeField ariaLabel={field.label} value={time} onChange={(h) => join(day, h)} className="w-28" allowEmpty />
        </div>
      );
    }
    case 'place':
    case 'place_time': {
      const place = (value as BriefPlace) || { place: '', address: '' };
      const set = (patch: Partial<BriefPlace>) => onChange({ ...place, ...patch });
      return (
        <div className={field.type === 'place_time' ? 'grid grid-cols-1 sm:grid-cols-[7rem_1fr_1fr] gap-2' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}>
          {field.type === 'place_time' && (
            <TimeField ariaLabel={t('briefs.input.time', 'Time')} value={place.time || ''} onChange={(time) => set({ time })} allowEmpty />
          )}
          <Input id={id} value={place.place} onChange={(e) => set({ place: e.target.value })} placeholder={t('briefs.input.place', 'Place') as string} maxLength={255} />
          <Input value={place.address} onChange={(e) => set({ address: e.target.value })} placeholder={t('briefs.input.address', 'Address (optional)') as string} aria-label={t('briefs.input.address', 'Address (optional)') as string} maxLength={500} />
        </div>
      );
    }
    case 'yes_no':
      return (
        <select id={id} value={value === null ? '' : value ? 'yes' : 'no'} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')} className="input w-full">
          <option value="">{t('briefs.input.notSet', 'Not set')}</option>
          <option value="yes">{t('briefs.yes', 'Yes')}</option>
          <option value="no">{t('briefs.no', 'No')}</option>
        </select>
      );
    case 'number':
    case 'project_guests':
      return <Input id={id} inputMode="decimal" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input id={id} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={field.type === 'project_location' ? 255 : 500} />;
  }
};
