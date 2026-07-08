import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Edit,
  Trash2,
  Search,
  GripVertical,
  Eye,
  EyeOff,
  X,
  AlertTriangle,
  Tags
} from 'lucide-react';

import { Button, Input, Card, Loading } from '../../components/common';
import { useModal, useMutationWithToast } from '../../hooks';
import { eventTypesService, EventType, CreateEventTypeData, UpdateEventTypeData } from '../../services/eventTypes.service';
import { GALLERY_THEME_PRESETS } from '../../types/theme.types';

// Common emoji options for event types
const EMOJI_OPTIONS = [
  '📷', '💒', '🎂', '🏢', '🎉', '🎊', '🎈', '👨‍👩‍👧', '💍', '🌸',
  '🎄', '🎃', '🐣', '🎓', '🏆', '🎸', '🎭', '🍽️', '🏖️', '✈️'
];

export const EventTypesPage: React.FC = () => {
  const { t } = useTranslation();

  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const createModal = useModal();
  const [editingType, setEditingType] = useState<EventType | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<EventType | null>(null);

  // Query
  const { data: eventTypes, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-event-types', showInactive],
    queryFn: () => eventTypesService.getEventTypes(showInactive)
  });

  // Mutations
  const createMutation = useMutationWithToast({
    mutationFn: eventTypesService.createEventType,
    invalidateKeys: [['admin-event-types']],
    successMessage: t('eventTypes.created', 'Event type created successfully'),
    errorMessage: t('eventTypes.createError', 'Failed to create event type'),
    onSuccess: () => {
      createModal.close();
    }
  });

  const updateMutation = useMutationWithToast({
    mutationFn: ({ id, data }: { id: number; data: UpdateEventTypeData }) =>
      eventTypesService.updateEventType(id, data),
    invalidateKeys: [['admin-event-types']],
    successMessage: t('eventTypes.updated', 'Event type updated successfully'),
    errorMessage: t('eventTypes.updateError', 'Failed to update event type'),
    onSuccess: () => {
      setEditingType(null);
    }
  });

  const deleteMutation = useMutationWithToast({
    mutationFn: eventTypesService.deleteEventType,
    invalidateKeys: [['admin-event-types']],
    successMessage: t('eventTypes.deleted', 'Event type deleted successfully'),
    errorMessage: t('eventTypes.deleteError', 'Failed to delete event type'),
    onSuccess: () => {
      setDeleteConfirm(null);
    }
  });

  // Filter event types
  const filteredTypes = useMemo(() => {
    if (!eventTypes) return [];
    if (!searchTerm) return eventTypes;

    const term = searchTerm.toLowerCase();
    return eventTypes.filter(type =>
      type.name.toLowerCase().includes(term) ||
      type.slug_prefix.toLowerCase().includes(term)
    );
  }, [eventTypes, searchTerm]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('eventTypes.loading', 'Loading event types...')} />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{t('eventTypes.loadError', 'Failed to load event types')}</p>
        <Button onClick={() => refetch()} className="mt-4">
          {t('common.tryAgain', 'Try Again')}
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
              <Tags className="w-6 h-6" />
              {t('eventTypes.title', 'Event Types')}
            </h1>
            <p className="text-neutral-600 dark:text-neutral-400 mt-1">
              {t('eventTypes.subtitle', 'Customize event types and their default themes')}
            </p>
          </div>
          <Button
            variant="primary"
            leftIcon={<Plus className="w-4 h-4" />}
            onClick={() => createModal.open()}
          >
            {t('eventTypes.createNew', 'New Event Type')}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <div className="p-4 flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <Input
              placeholder={t('eventTypes.searchPlaceholder', 'Search event types...')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              leftIcon={<Search className="w-4 h-4" />}
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
            />
            <span className="text-sm text-neutral-700 dark:text-neutral-300">
              {t('eventTypes.showInactive', 'Show inactive')}
            </span>
          </label>
        </div>
      </Card>

      {/* Event Types List */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase w-10">
                  {/* Drag handle column */}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase">
                  {t('eventTypes.table.type', 'Type')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase">
                  {t('eventTypes.table.slugPrefix', 'URL Prefix')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase">
                  {t('eventTypes.table.theme', 'Default Theme')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase">
                  {t('eventTypes.table.status', 'Status')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase">
                  {t('eventTypes.table.actions', 'Actions')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-700">
              {filteredTypes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-neutral-500 dark:text-neutral-400">
                    {searchTerm
                      ? t('eventTypes.noResults', 'No event types found')
                      : t('eventTypes.empty', 'No event types yet')}
                  </td>
                </tr>
              ) : (
                filteredTypes.map((type) => (
                  <tr key={type.id} className={`hover:bg-neutral-50 dark:hover:bg-neutral-700/50 ${!type.is_active ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-4">
                      <GripVertical className="w-4 h-4 text-neutral-400 cursor-grab" />
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{type.emoji}</span>
                        <div>
                          <div className="font-medium text-neutral-900 dark:text-neutral-100">{type.name}</div>
                          {type.is_system && (
                            <span className="text-xs text-neutral-500 dark:text-neutral-400">
                              {t('eventTypes.system', 'System')}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <code className="px-2 py-1 bg-neutral-100 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 rounded text-sm">
                        {type.slug_prefix}
                      </code>
                    </td>
                    <td className="px-4 py-4 text-sm text-neutral-600 dark:text-neutral-300">
                      {GALLERY_THEME_PRESETS[type.theme_preset]?.name || type.theme_preset || '-'}
                    </td>
                    <td className="px-4 py-4">
                      {type.is_active ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 rounded-full text-xs">
                          <Eye className="w-3 h-3" />
                          {t('common.active', 'Active')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400 rounded-full text-xs">
                          <EyeOff className="w-3 h-3" />
                          {t('common.inactive', 'Inactive')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setEditingType(type)}
                          className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg text-neutral-600 dark:text-neutral-400 hover:text-accent"
                          title={t('common.edit', 'Edit')}
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        {!type.is_system && (
                          <button
                            onClick={() => setDeleteConfirm(type)}
                            className="p-2 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg text-neutral-600 dark:text-neutral-400 hover:text-red-600"
                            title={t('common.delete', 'Delete')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Slug Preview Info */}
      <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800">
        <p className="text-sm text-blue-800 dark:text-blue-200">
          <strong>{t('eventTypes.slugInfo.title', 'URL Prefix Info:')}</strong>{' '}
          {t('eventTypes.slugInfo.description', 'The URL prefix is used to generate gallery URLs. For example, an event type with prefix "family" will create URLs like: family-smith-family-2025-01-22')}
        </p>
      </div>

      {/* Create Modal */}
      {createModal.isOpen && (
        <EventTypeModal
          onClose={createModal.close}
          onSubmit={(data) => createMutation.mutate(data as CreateEventTypeData)}
          isLoading={createMutation.isPending}
        />
      )}

      {/* Edit Modal */}
      {editingType && (
        <EventTypeModal
          eventType={editingType}
          onClose={() => setEditingType(null)}
          onSubmit={(data) => updateMutation.mutate({ id: editingType.id, data })}
          isLoading={updateMutation.isPending}
        />
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <DeleteConfirmModal
          eventType={deleteConfirm}
          onClose={() => setDeleteConfirm(null)}
          onConfirm={() => deleteMutation.mutate(deleteConfirm.id)}
          isLoading={deleteMutation.isPending}
        />
      )}
    </div>
  );
};

// Event Type Modal Component
interface EventTypeModalProps {
  eventType?: EventType;
  onClose: () => void;
  onSubmit: (data: CreateEventTypeData | UpdateEventTypeData) => void;
  isLoading: boolean;
}

const EventTypeModal: React.FC<EventTypeModalProps> = ({
  eventType,
  onClose,
  onSubmit,
  isLoading
}) => {
  const { t } = useTranslation();
  const isEditing = !!eventType;

  const [form, setForm] = useState<CreateEventTypeData>({
    name: eventType?.name || '',
    slug_prefix: eventType?.slug_prefix || '',
    emoji: eventType?.emoji || '📷',
    theme_preset: eventType?.theme_preset || 'default'
  });

  const [errors, setErrors] = useState<Partial<Record<keyof CreateEventTypeData, string>>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: typeof errors = {};

    if (!form.name.trim()) {
      newErrors.name = t('validation.required', 'This field is required');
    }

    if (!form.slug_prefix.trim()) {
      newErrors.slug_prefix = t('validation.required', 'This field is required');
    } else if (!/^[a-z0-9-]+$/i.test(form.slug_prefix)) {
      newErrors.slug_prefix = t('eventTypes.validation.slugFormat', 'Only letters, numbers, and hyphens allowed');
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    // For editing, only send changed fields (plus is_active if toggling)
    if (isEditing) {
      const updates: UpdateEventTypeData = {};
      if (form.name !== eventType?.name) updates.name = form.name;
      if (form.slug_prefix !== eventType?.slug_prefix) updates.slug_prefix = form.slug_prefix;
      if (form.emoji !== eventType?.emoji) updates.emoji = form.emoji;
      if (form.theme_preset !== eventType?.theme_preset) updates.theme_preset = form.theme_preset;
      onSubmit(updates);
    } else {
      onSubmit(form);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {isEditing
                ? t('eventTypes.edit', 'Edit Event Type')
                : t('eventTypes.createNew', 'New Event Type')}
            </h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
              disabled={isLoading}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              {/* Name */}
              <Input
                label={t('eventTypes.form.name', 'Display Name')}
                placeholder={t('eventTypes.form.namePlaceholder', 'e.g., Family Shoot')}
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                  setErrors({ ...errors, name: undefined });
                }}
                error={errors.name}
              />

              {/* Slug Prefix */}
              <div>
                <Input
                  label={t('eventTypes.form.slugPrefix', 'URL Prefix')}
                  placeholder={t('eventTypes.form.slugPrefixPlaceholder', 'e.g., family')}
                  value={form.slug_prefix}
                  onChange={(e) => {
                    const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                    setForm({ ...form, slug_prefix: value });
                    setErrors({ ...errors, slug_prefix: undefined });
                  }}
                  error={errors.slug_prefix}
                />
                {form.slug_prefix && (
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {t('eventTypes.form.slugPreview', 'Example URL:')}{' '}
                    <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                      {form.slug_prefix}-event-name-2025-01-22
                    </code>
                  </p>
                )}
              </div>

              {/* Emoji */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('eventTypes.form.emoji', 'Icon')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {EMOJI_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setForm({ ...form, emoji })}
                      className={`p-2 text-xl rounded-lg border-2 transition-all ${
                        form.emoji === emoji
                          ? 'tile-selected'
                          : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Theme Preset */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('eventTypes.form.themePreset', 'Default Theme')}
                </label>
                <select
                  value={form.theme_preset}
                  onChange={(e) => setForm({ ...form, theme_preset: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                >
                  {Object.entries(GALLERY_THEME_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Active toggle for editing */}
              {isEditing && (
                <label className="flex items-center gap-3 pt-2">
                  <input
                    type="checkbox"
                    checked={eventType?.is_active}
                    onChange={(e) => onSubmit({ is_active: e.target.checked })}
                    className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                  />
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">
                    {t('eventTypes.form.isActive', 'Active (visible in event creation)')}
                  </span>
                </label>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
              <Button variant="outline" onClick={onClose} disabled={isLoading}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" type="submit" isLoading={isLoading}>
                {isEditing ? t('common.save', 'Save') : t('common.create', 'Create')}
              </Button>
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
};

// Delete Confirmation Modal
interface DeleteConfirmModalProps {
  eventType: EventType;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  eventType,
  onClose,
  onConfirm,
  isLoading
}) => {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-red-100 dark:bg-red-900/40 rounded-full">
              <AlertTriangle className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('eventTypes.deleteConfirm.title', 'Delete Event Type')}
            </h2>
          </div>

          <p className="text-neutral-600 dark:text-neutral-400 mb-4">
            {t('eventTypes.deleteConfirm.message', 'Are you sure you want to delete')} "{eventType.name}"?
          </p>

          <p className="text-sm text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-700 p-3 rounded-lg mb-6">
            {t('eventTypes.deleteConfirm.warning', 'This action cannot be undone. Make sure no events are using this type.')}
          </p>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onClose} disabled={isLoading}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              isLoading={isLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {t('common.delete', 'Delete')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default EventTypesPage;
