import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Plus, X } from 'lucide-react';

import { Button, Input, Loading, Notice } from '../common';
import { eventTypesService, EventType } from '../../services/eventTypes.service';

interface Props {
  onDone: () => void;
}

// One editable row of the wizard's event-type list. Existing rows carry the
// catalog id; rows added in the wizard have no id until Continue POSTs them.
interface RowState {
  id?: number;
  name: string;
  slug_prefix: string;
  emoji: string;
}

const normalizeSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-');

// First-run event-types step (#800). Shown once, during the setup wizard —
// the only window in which the seeded SYSTEM types may be deleted (nothing
// references them yet; the backend re-locks them when the wizard finishes).
// Deliberately lean: name + URL prefix only. Icons, themes and ordering are
// tunable later in Settings → Event Types.
export const SetupEventTypesStep: React.FC<Props> = ({ onDone }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [original, setOriginal] = useState<Map<number, EventType>>(new Map());
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  const { isLoading, isError } = useQuery({
    queryKey: ['setup-event-types'],
    queryFn: async () => {
      const types = await eventTypesService.getEventTypes();
      // Initialize once — a re-run (remount) must not clobber in-progress edits.
      setOriginal((prev) => (prev.size > 0 ? prev : new Map(types.map((et) => [et.id, et]))));
      setRows((prev) => prev ?? types.map((et) => ({ id: et.id, name: et.name, slug_prefix: et.slug_prefix, emoji: et.emoji })));
      return types;
    },
    staleTime: Infinity,
  });

  const setRow = (index: number, patch: Partial<RowState>) => {
    setRows((prev) => (prev ? prev.map((r, i) => (i === index ? { ...r, ...patch } : r)) : prev));
  };

  const removeRow = (index: number) => {
    // No side effects inside the setRows updater — StrictMode double-invokes
    // updaters, which would enqueue the same id twice (one DELETE 404s and
    // shows a false "could not save" warning).
    const row = rows?.[index];
    if (!row) return;
    if (row.id !== undefined) {
      setDeletedIds((ids) => (ids.includes(row.id!) ? ids : [...ids, row.id!]));
    }
    setRows((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
  };

  const addRow = () => {
    setRows((prev) => (prev ? [...prev, { name: '', slug_prefix: '', emoji: '📷' }] : prev));
  };

  // Apply the diff, then advance. Ordering matters twice over: deletes first
  // frees a default's slug for a rename/re-create ("replace Wedding with my
  // own 'wedding'"), but deleting everything BEFORE a replacement exists could
  // empty the catalog if the creation then fails. So: when at least one
  // existing row is kept the catalog can never go empty → delete first; when
  // the user replaces ALL types → create first and only delete once at least
  // one replacement actually persisted. (The backend additionally refuses
  // deleting the last remaining type.) Best-effort like the other wizard
  // steps — a partial failure warns but never traps the user; everything here
  // is editable later in Settings → Event Types.
  const handleContinue = async () => {
    if (!rows) return;
    const kept = rows.filter((r) => r.name.trim() && r.slug_prefix.trim());
    if (kept.length === 0) {
      toast.error(t('setup.eventTypes.atLeastOne'));
      return;
    }
    setSaving(true);
    let failures = 0;
    let deleteFailures = 0;
    let createdOk = 0;

    const applyDeletes = async () => {
      for (const id of deletedIds) {
        try {
          await eventTypesService.deleteEventType(id);
        } catch {
          deleteFailures += 1;
        }
      }
    };
    const applyCreatesAndUpdates = async () => {
      for (const row of kept) {
        try {
          if (row.id !== undefined) {
            const before = original.get(row.id);
            const updates: { name?: string; slug_prefix?: string } = {};
            if (before && row.name.trim() !== before.name) updates.name = row.name.trim();
            if (before && row.slug_prefix !== before.slug_prefix) updates.slug_prefix = row.slug_prefix;
            if (Object.keys(updates).length > 0) {
              await eventTypesService.updateEventType(row.id, updates);
            }
          } else {
            await eventTypesService.createEventType({
              name: row.name.trim(),
              slug_prefix: row.slug_prefix,
              emoji: row.emoji,
            });
            createdOk += 1;
          }
        } catch {
          failures += 1;
        }
      }
    };

    const keptExisting = kept.filter((r) => r.id !== undefined).length;
    if (keptExisting > 0) {
      await applyDeletes();
      await applyCreatesAndUpdates();
    } else {
      await applyCreatesAndUpdates();
      if (deletedIds.length > 0 && createdOk === 0) {
        // Every replacement failed — deleting now would empty the catalog.
        // Keep the seeded types and stay on the step.
        setSaving(false);
        toast.error(t('setup.eventTypes.atLeastOne'));
        return;
      }
      await applyDeletes();
    }

    // A failed DELETE must not slip past this step: system types are only
    // deletable inside this window, so once the wizard finishes the request
    // can never be retried. Reload the live catalog and stay for a retry.
    if (deleteFailures > 0) {
      try {
        const types = await eventTypesService.getEventTypes();
        setOriginal(new Map(types.map((et) => [et.id, et])));
        setRows(types.map((et) => ({ id: et.id, name: et.name, slug_prefix: et.slug_prefix, emoji: et.emoji })));
      } catch { /* keep the local rows if the reload fails */ }
      setDeletedIds([]);
      setSaving(false);
      toast.error(t('setup.eventTypes.deleteFailed'));
      return;
    }

    setSaving(false);
    if (failures > 0) toast.warn(t('setup.eventTypes.saveFailed'));
    onDone();
  };

  if (isLoading || rows === null) {
    return isError ? (
      // Catalog unreadable — don't trap the user; the defaults stay seeded and
      // remain editable later in Settings → Event Types.
      <div className="space-y-6">
        <Notice tone="warning">{t('setup.eventTypes.loadFailed')}</Notice>
        <Button type="button" variant="primary" size="lg" className="w-full" onClick={onDone}>
          {t('setup.continue')}
        </Button>
      </div>
    ) : (
      <Loading />
    );
  }

  return (
    <div className="space-y-6">
      <p className="rounded-lg bg-subtle border border-line px-3 py-2 text-xs text-soft">
        {t('setup.eventTypes.intro')}
      </p>

      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={row.id ?? `new-${index}`} className="flex items-center gap-2">
            <span className="w-8 text-center text-xl flex-shrink-0" aria-hidden="true">{row.emoji}</span>
            <div className="flex-1 min-w-0">
              <Input
                value={row.name}
                onChange={(e) => setRow(index, { name: e.target.value })}
                placeholder={t('setup.eventTypes.namePlaceholder')}
                aria-label={t('setup.eventTypes.nameLabel')}
              />
            </div>
            <div className="w-32 flex-shrink-0">
              <Input
                value={row.slug_prefix}
                onChange={(e) => setRow(index, { slug_prefix: normalizeSlug(e.target.value) })}
                placeholder={t('setup.eventTypes.slugPlaceholder')}
                aria-label={t('setup.eventTypes.slugLabel')}
              />
            </div>
            <button
              type="button"
              onClick={() => removeRow(index)}
              className="flex-shrink-0 p-2 rounded-lg text-faint hover:text-danger-text hover:bg-danger-soft transition-colors"
              aria-label={t('common.delete', 'Delete')}
              title={t('common.delete', 'Delete')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="w-full rounded-lg border border-dashed border-line-strong p-3 text-left hover:bg-hover-soft transition-colors flex items-center gap-2"
      >
        <Plus className="w-4 h-4 text-muted" />
        <span className="text-sm font-medium text-heading">{t('setup.eventTypes.add')}</span>
      </button>

      <p className="text-xs text-muted">{t('setup.eventTypes.hint')}</p>

      <Button
        type="button"
        variant="primary"
        size="lg"
        isLoading={saving}
        className="w-full"
        onClick={handleContinue}
      >
        {t('setup.continue')}
      </Button>
    </div>
  );
};

SetupEventTypesStep.displayName = 'SetupEventTypesStep';
