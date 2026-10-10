import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Tag,
  Plus,
  Edit,
  Trash2,
  Search,
  GripVertical,
  Eye,
  EyeOff,
  AlertTriangle
} from 'lucide-react';

import { Badge, Button, Input, Card, EmptyState, ErrorState, Loading, Modal, Notice, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from '../../components/common';
import { useModal, useMutationWithToast } from '../../hooks';
import { eventTypesService, EventType, CreateEventTypeData, UpdateEventTypeData } from '../../services/eventTypes.service';
import { GALLERY_THEME_PRESETS } from '../../types/theme.types';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';

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
  if (error && !eventTypes) {
    return (
      <ErrorState
        title={t('eventTypes.loadError', 'Failed to load event types')}
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <div>
      <SectionPageHeader
        icon={Tag}
        title={t('eventTypes.title', 'Event Types')}
        description={t('eventTypes.subtitle', 'Customize event types and their default themes')}
        actions={(
          <>
            <Button
              variant="primary"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => createModal.open()}
            >
              {t('eventTypes.createNew', 'New Event Type')}
            </Button>
          </>
        )}
      />

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
              className="rounded border-line-strong text-accent focus:ring-accent"
            />
            <span className="text-sm text-body">
              {t('eventTypes.showInactive', 'Show inactive')}
            </span>
          </label>
        </div>
      </Card>

      {/* Event Types List */}
      <Table>
        <TableHead>
          <tr>
            <TableHeaderCell className="w-10">
              {/* Drag handle column */}
            </TableHeaderCell>
            <TableHeaderCell>
              {t('eventTypes.table.type', 'Type')}
            </TableHeaderCell>
            <TableHeaderCell>
              {t('eventTypes.table.slugPrefix', 'URL Prefix')}
            </TableHeaderCell>
            <TableHeaderCell>
              {t('eventTypes.table.theme', 'Default Theme')}
            </TableHeaderCell>
            <TableHeaderCell>
              {t('eventTypes.table.status', 'Status')}
            </TableHeaderCell>
            <TableHeaderCell align="right">
              {t('eventTypes.table.actions', 'Actions')}
            </TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {filteredTypes.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6}>
                <EmptyState
                  size="inline"
                  icon={<Tag />}
                  title={searchTerm
                    ? t('eventTypes.noResults', 'No event types found')
                    : t('eventTypes.empty', 'No event types yet')}
                />
              </TableCell>
            </TableRow>
          ) : (
            filteredTypes.map((type) => (
              <TableRow key={type.id} className={`hover:bg-hover-soft ${!type.is_active ? 'opacity-60' : ''}`}>
                <TableCell>
                  <GripVertical className="w-4 h-4 text-faint cursor-grab" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{type.emoji}</span>
                    <div>
                      <div className="font-medium text-heading">{type.name}</div>
                      {type.is_system && (
                        <span className="text-xs text-muted">
                          {t('eventTypes.system', 'System')}
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <code className="px-2 py-1 bg-inset text-heading rounded text-sm">
                    {type.slug_prefix}
                  </code>
                </TableCell>
                <TableCell>
                  {GALLERY_THEME_PRESETS[type.theme_preset]?.name || type.theme_preset || '-'}
                </TableCell>
                <TableCell>
                  {type.is_active ? (
                    <Badge tone="success" icon={<Eye />}>
                      {t('common.active', 'Active')}
                    </Badge>
                  ) : (
                    <Badge icon={<EyeOff />}>
                      {t('common.inactive', 'Inactive')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setEditingType(type)}
                      className="p-2 hover:bg-hover rounded-lg text-soft hover:text-accent"
                      title={t('common.edit', 'Edit')}
                      aria-label={t('common.edit', 'Edit')}
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                    {!type.is_system && (
                      <button
                        onClick={() => setDeleteConfirm(type)}
                        className="p-2 hover:bg-danger-soft rounded-lg text-soft hover:text-danger-text"
                        title={t('common.delete', 'Delete')}
                        aria-label={t('common.delete', 'Delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Slug Preview Info */}
      <Notice tone="info" className="mt-4">
        <strong>{t('eventTypes.slugInfo.title', 'URL Prefix Info:')}</strong>{' '}
        {t('eventTypes.slugInfo.description', 'The URL prefix is used to generate gallery URLs. For example, an event type with prefix "family" will create URLs like: family-smith-family-2025-01-22')}
      </Notice>

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
    <Modal
      open
      onClose={() => { if (!isLoading) onClose(); }}
      size="md"
      title={isEditing
        ? t('eventTypes.edit', 'Edit Event Type')
        : t('eventTypes.createNew', 'New Event Type')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="primary" type="submit" form="event-type-form" isLoading={isLoading}>
            {isEditing ? t('common.save', 'Save') : t('common.create', 'Create')}
          </Button>
        </>
      )}
    >
          <form id="event-type-form" onSubmit={handleSubmit}>
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
                  <p className="mt-1 text-xs text-muted">
                    {t('eventTypes.form.slugPreview', 'Example URL:')}{' '}
                    <code className="bg-inset px-1 rounded">
                      {form.slug_prefix}-event-name-2025-01-22
                    </code>
                  </p>
                )}
              </div>

              {/* Emoji */}
              <div>
                <label className="block text-sm font-medium text-body mb-2">
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
                          : 'border-line hover:border-line-strong'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Theme Preset */}
              <div>
                <label className="block text-sm font-medium text-body mb-2">
                  {t('eventTypes.form.themePreset', 'Default Theme')}
                </label>
                <select
                  value={form.theme_preset}
                  onChange={(e) => setForm({ ...form, theme_preset: e.target.value })}
                  className="w-full px-3 py-2 border border-line-strong bg-panel text-heading rounded-lg focus:ring-2 focus:ring-accent focus:border-accent-dark"
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
                    className="rounded border-line-strong text-accent focus:ring-accent"
                  />
                  <span className="text-sm text-body">
                    {t('eventTypes.form.isActive', 'Active (offered when creating a gallery)')}
                  </span>
                </label>
              )}
            </div>
          </form>
    </Modal>
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

  // Stays open while the delete runs and on a failure; the page closes it
  // on success.
  return (
    <Modal
      open
      onClose={() => { if (!isLoading) onClose(); }}
      size="sm"
      title={t('eventTypes.deleteConfirm.title', 'Delete Event Type')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            isLoading={isLoading}
          >
            {t('eventTypes.deleteConfirm.action', 'Delete event type')}
          </Button>
        </>
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 flex-shrink-0 text-danger-text" aria-hidden="true" />
        <div className="space-y-3">
          <p className="text-soft">
            {t('eventTypes.deleteConfirm.message', 'Are you sure you want to delete')} "{eventType.name}"?
          </p>
          <p className="text-sm text-muted">
            {t('eventTypes.deleteConfirm.warning', 'This action cannot be undone. Make sure no galleries use this type.')}
          </p>
        </div>
      </div>
    </Modal>
  );
};

export default EventTypesPage;
