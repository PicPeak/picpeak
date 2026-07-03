/**
 * <EventReminderOverrideCard>
 *
 * Per-event override for the pre-event customer reminder (migration
 * 143). Mounted once on the EventDetailsPage; admin can:
 *   - Disable the reminder for THIS event only (no global flip)
 *   - Override the global "days before" offset (null = inherit)
 *   - Provide a custom body that overrides the resolved template's
 *     body for THIS event only (subject still comes from the template)
 *
 * Saves through the existing PUT /api/admin/events/:id endpoint with
 * the three new whitelisted fields (added 2026-05-25):
 *   - event_reminder_disabled        (bool)
 *   - event_reminder_offset_days     (int | null)
 *   - event_reminder_body_override   (string | null)
 *
 * Behaves correctly on pre-migration installs: if the event object
 * doesn't carry the new fields, the form starts blank and "Reset to
 * default" is a no-op until admin saves something.
 *
 * Strings: every label / hint / button goes through `t()` with a
 * fallback. The maintainer flagged "no hard coded i18n" in commit #5
 * — applying that convention strictly from here forward.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Bell, BellOff, Save } from 'lucide-react';
import { Button, Card, Input } from '../common';
import { api } from '../../config/api';

export interface EventReminderOverrideCardProps {
  eventId: number;
  /** Initial values from the event row; null when unset. */
  initial: {
    event_reminder_disabled?: boolean;
    event_reminder_offset_days?: number | null;
    event_reminder_body_override?: string | null;
  };
  /** Optional callback so the parent can refresh its event query
   *  after a save. */
  onSaved?: () => void;
}

export const EventReminderOverrideCard: React.FC<EventReminderOverrideCardProps> = ({
  eventId, initial, onSaved,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [disabled, setDisabled] = useState<boolean>(!!initial.event_reminder_disabled);
  const [offsetDays, setOffsetDays] = useState<string>(
    initial.event_reminder_offset_days == null ? '' : String(initial.event_reminder_offset_days),
  );
  const [bodyOverride, setBodyOverride] = useState<string>(initial.event_reminder_body_override || '');

  // Reset local state if the parent's `initial` changes (e.g. after
  // the event refetches following an unrelated save).
  useEffect(() => {
    setDisabled(!!initial.event_reminder_disabled);
    setOffsetDays(initial.event_reminder_offset_days == null ? '' : String(initial.event_reminder_offset_days));
    setBodyOverride(initial.event_reminder_body_override || '');
  }, [initial.event_reminder_disabled, initial.event_reminder_offset_days, initial.event_reminder_body_override]);

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        event_reminder_disabled: disabled,
      };
      // Empty string → null clears the override and inherits global.
      if (offsetDays.trim() === '') {
        payload.event_reminder_offset_days = null;
      } else {
        const n = Number(offsetDays);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(t('eventReminderOverride.invalidOffset',
            'Offset must be a non-negative integer or blank.') as string);
        }
        payload.event_reminder_offset_days = Math.floor(n);
      }
      payload.event_reminder_body_override = bodyOverride.trim() === '' ? null : bodyOverride;
      await api.put(`/admin/events/${eventId}`, payload);
    },
    onSuccess: () => {
      toast.success(t('eventReminderOverride.saved', 'Reminder override saved.'));
      queryClient.invalidateQueries({ queryKey: ['admin-event', eventId] });
      queryClient.invalidateQueries({ queryKey: ['adminEvent', eventId] });
      onSaved?.();
    },
    onError: (err: unknown) => {
      const e = err as { message?: string; response?: { data?: { error?: string } } };
      toast.error(
        e?.response?.data?.error
        || e?.message
        || t('eventReminderOverride.saveError', 'Could not save reminder override.'),
      );
    },
  });

  return (
    <Card padding="lg" className="mt-4">
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          {disabled
            ? <BellOff className="w-5 h-5 text-muted-theme" aria-hidden />
            : <Bell className="w-5 h-5" aria-hidden />}
          <h2 className="text-lg font-semibold">
            {t('eventReminderOverride.title', 'Pre-event reminder')}
          </h2>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => save.mutate()}
          isLoading={save.isPending}
          disabled={save.isPending}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {t('eventReminderOverride.save', 'Save override')}
        </Button>
      </div>

      <p className="text-xs text-muted-theme mb-3">
        {t('eventReminderOverride.help',
          'Per-event override for the customer reminder. Global on-off + default offset live under Settings → Reminder emails. Anything left blank here inherits the global setting / resolved template.')}
      </p>

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          {t('eventReminderOverride.disabledLabel',
            'Disable the reminder for this event (no email goes out)')}
        </label>

        <div>
          <Input
            type="number"
            min={0}
            max={365}
            label={t('eventReminderOverride.offsetLabel',
              'Days before the event (override) — leave blank to inherit') as string}
            value={offsetDays}
            onChange={(e) => setOffsetDays(e.target.value)}
            placeholder={t('eventReminderOverride.offsetPlaceholder',
              'Leave blank to use the global default') as string}
            disabled={disabled}
            className="md:w-80"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            {t('eventReminderOverride.bodyOverrideLabel',
              'Custom body for this event (overrides the resolved template body)')}
          </label>
          <textarea
            rows={6}
            className="input w-full text-sm"
            placeholder={t('eventReminderOverride.bodyOverridePlaceholder',
              'Leave blank to use the template body. Variables like {{customer_name}}, {{event_name}}, {{event_date}} still work here.') as string}
            value={bodyOverride}
            onChange={(e) => setBodyOverride(e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>
    </Card>
  );
};

export default EventReminderOverrideCard;
