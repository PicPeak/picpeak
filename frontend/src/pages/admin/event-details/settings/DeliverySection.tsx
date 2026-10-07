/**
 * Folders & delivery (issues 1786 + 1562).
 *
 * Folders: whether uploads and imports mirror their subfolders. It controls
 * ingest only — turning it off never flattens folders that already exist.
 *
 * Delivery: complete (today's behaviour) or a first look with more to come.
 * The fields are part of the draft and save with the bar; "Full gallery is
 * ready" is an action, not a field, so it acts immediately through its own
 * dialog. A FirstLook keyword folder switches the gallery to two-stage
 * delivery on upload; this section is also how a gallery without one gets it.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, FolderTree, Sparkles } from 'lucide-react';
import type { Event } from '../../../../types';
import { Button, Input, LocalizedDateInput } from '../../../../components/common';
import { useLocalizedDate } from '../../../../hooks/useLocalizedDate';
import { usePermission } from '../../../../hooks/usePermission';
import { eventsService } from '../../../../services/events.service';
import { CompleteDeliveryDialog } from '../CompleteDeliveryDialog';
import { SectionCard, checkboxClass, labelClass, type FieldsProps } from './sections';
import { deliveryDue } from '../deliveryStatus';

export const DeliverySection: React.FC<FieldsProps & { event: Event; onChanged: () => void }> = ({ f, set, event, onChanged }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const canComplete = usePermission('events.edit');
  const [completeOpen, setCompleteOpen] = useState(false);

  const { data: state, refetch } = useQuery({
    queryKey: ['event-delivery', event.id],
    queryFn: () => eventsService.getDelivery(event.id),
  });

  const savedPartial = state?.status === 'partial';
  const due = deliveryDue(state?.due_at ?? null);
  const expected = state?.expected_count ?? null;

  return (
    <>
      <SectionCard
        title={t('events.folders.sectionTitle', 'Folders')}
        description={t('events.folders.sectionHelp', 'Subfolders of an upload, or of the linked external folder, become nested gallery folders (at most three levels). Turning this off only affects new uploads and scans; existing folders stay as they are.')}
      >
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className={`${checkboxClass} mt-0.5`}
            checked={f.folder_structure}
            onChange={(e) => set({ folder_structure: e.target.checked })}
          />
          <span>
            <span className="text-heading font-medium flex items-center gap-1.5">
              <FolderTree className="w-4 h-4 text-muted" />
              {t('events.folders.mirror', 'Mirror folder structure on upload and import')}
            </span>
            <span className="text-xs text-muted block mt-0.5">
              {t('events.folders.mirrorHelp', 'The upload dialog can still switch this per upload.')}
            </span>
          </span>
        </label>
      </SectionCard>

      <SectionCard
        title={t('events.delivery.sectionTitle', 'Two-stage delivery')}
        description={t('events.delivery.sectionHelp', 'Deliver a first look now and the complete gallery later. Guests see the first photos with a badge, a note that more are coming, and placeholder tiles until you mark the full gallery as ready.')}
      >
        <div className="inline-flex rounded-lg border border-line-strong overflow-hidden" role="radiogroup" aria-label={t('events.delivery.sectionTitle', 'Two-stage delivery')}>
          {(['complete', 'partial'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={f.delivery_status === value}
              onClick={() => set({ delivery_status: value })}
              className={`px-4 py-2 text-sm ${f.delivery_status === value
                ? 'bg-accent text-white font-semibold'
                : 'text-body hover:bg-hover'}`}
            >
              {value === 'complete'
                ? t('events.delivery.statusComplete', 'Complete')
                : t('events.delivery.statusPartial', 'First look, more to come')}
            </button>
          ))}
        </div>

        {savedPartial && state && (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-line bg-inset px-4 py-3">
            <div>
              <div className="text-xl font-bold text-heading tabular-nums">
                {state.delivered_count}
                {expected ? <span className="text-sm font-medium text-muted"> {t('events.delivery.ofApprox', 'of ~{{count}}', { count: expected })}</span> : null}
              </div>
              {expected ? (
                <div className="mt-1.5 h-1.5 w-48 rounded-full bg-fill overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.round((state.delivered_count / expected) * 100))}%` }} />
                </div>
              ) : null}
            </div>
            <div className="text-sm space-y-0.5">
              <p className="text-muted flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" />
                {t('events.delivery.badged', '{{count}} photos badged "{{label}}"', {
                  count: state.first_look_count,
                  label: state.badge_label || t('gallery.firstLook', 'First look'),
                })}
              </p>
              {due && (
                <p className={`flex items-center gap-1.5 ${due.tone === 'overdue' ? 'text-red-600 dark:text-red-400' : due.tone === 'soon' ? 'text-amber-600 dark:text-amber-400' : 'text-body'}`}>
                  <Clock className="w-4 h-4" />
                  {due.tone === 'overdue'
                    ? t('events.delivery.overdueSince', 'Promised by {{date}} — overdue', { date: format(due.date) })
                    : t('events.delivery.promisedBy', 'Promised by {{date}} · in {{count}} days', { date: format(due.date), count: due.days })}
                </p>
              )}
            </div>
            {canComplete && (
              <Button
                variant="primary"
                size="sm"
                className="ml-auto"
                leftIcon={<CheckCircle2 className="w-4 h-4" />}
                onClick={() => setCompleteOpen(true)}
              >
                {t('events.delivery.completeButton', 'Full gallery is ready')}
              </Button>
            )}
          </div>
        )}

        {state?.status === 'complete' && state.completed_at && (
          <p className="text-sm rounded-lg bg-inset text-body px-3 py-2">
            {t('events.delivery.completedOn', 'Completed on {{date}}. The first-look badges stay on their photos.', { date: format(new Date(state.completed_at)) })}
          </p>
        )}

        {f.delivery_status === 'partial' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass} htmlFor="settings-delivery-expected">
                {t('events.delivery.expected', 'Expected number of photos')}
              </label>
              <Input
                id="settings-delivery-expected"
                type="number"
                min={1}
                value={f.delivery_expected_count}
                onChange={(e) => set({ delivery_expected_count: e.target.value })}
              />
              <p className="text-xs text-muted mt-1">
                {t('events.delivery.expectedHelp', 'Approximate. Only used for the guest note and the placeholder tiles.')}
              </p>
            </div>
            <div>
              <label className={labelClass}>
                {t('events.delivery.dueAt', 'Complete gallery promised by')}
                {state?.due_source === 'default' && (
                  <span className="ml-2 text-[11px] font-medium rounded-full border border-line-strong px-2 py-0.5 text-muted">
                    {t('events.delivery.dueDefault', 'default')}
                  </span>
                )}
              </label>
              <LocalizedDateInput value={f.delivery_due_at} onChange={(iso) => set({ delivery_due_at: iso })} />
              <p className="text-xs text-muted mt-1">
                {t('events.delivery.dueHelp', 'Shown to guests and used for your reminder. Empty: event date plus the default from Settings → Events.')}
              </p>
            </div>
            <div>
              <label className={labelClass} htmlFor="settings-delivery-badge">
                {t('events.delivery.badgeLabel', 'Badge label')}
              </label>
              <Input
                id="settings-delivery-badge"
                type="text"
                maxLength={60}
                value={f.delivery_badge_label}
                placeholder={t('gallery.firstLook', 'First look') as string}
                onChange={(e) => set({ delivery_badge_label: e.target.value })}
              />
              <p className="text-xs text-muted mt-1">
                {t('events.delivery.badgeHelp', 'For example "Social media pre-delivery". The badge stays on these photos after the full gallery lands.')}
              </p>
            </div>
          </div>
        )}

        {f.delivery_status === 'complete' && savedPartial && (
          <p className="text-xs rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 px-3 py-2">
            {t('events.delivery.switchOffHint', 'Saving "Complete" here only removes the note and placeholders — no email is sent. Use "Full gallery is ready" to tell the customer.')}
          </p>
        )}
      </SectionCard>

      {state && (
        <CompleteDeliveryDialog
          event={event}
          state={state}
          isOpen={completeOpen}
          onClose={() => setCompleteOpen(false)}
          onCompleted={() => { refetch(); onChanged(); }}
        />
      )}
    </>
  );
};
