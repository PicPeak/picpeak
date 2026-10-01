import React, { useEffect, useState } from 'react';
import { Plus, Trash2, ShieldAlert, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { Button, Card, Input, Loading } from '../../../components/common';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import { api } from '../../../config/api';
import { usePermission } from '../../../hooks/usePermission';

/**
 * Settings → PicTransfer (#1544).
 *
 * Which file types a client may send through a file request, and how large.
 *
 * This list is deliberately NOT `general_allowed_file_types`. That one governs
 * gallery photo uploads, which sharp/ffmpeg decode, and widening it so a client
 * can send a .psd would widen what the media pipeline is handed. Transfer files
 * are only stored and handed back as bytes, so they get their own list — and
 * an escape hatch for the photographer who just wants everything to arrive.
 *
 * Before #1544 this lived only in the database: allowing an SVG meant running
 * an UPDATE against app_settings by hand.
 */

interface AllowedType {
  mime: string;
  extensions: string[];
}

interface TransferSettings {
  accept_all: boolean;
  allowed_types: AllowedType[];
  max_size_mb: number;
}

/** Display form: `.jpg, .jpeg` — what the admin actually thinks in. */
function extensionsToText(extensions: string[]): string {
  return extensions.join(', ');
}

function textToExtensions(text: string): string[] {
  return [...new Set(
    text
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
      .map((e) => (e.startsWith('.') ? e : `.${e}`)),
  )];
}

export const TransfersTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TransferSettings | null>(null);
  // What the server last sent — dirty is a comparison against it.
  const [loaded, setLoaded] = useState<TransferSettings | null>(null);
  const isDirty = JSON.stringify(form) !== JSON.stringify(loaded);
  // The PUT requires settings.edit. Without this an admin holding only
  // settings.view sees a live form and earns a 403 toast on Save.
  const canEdit = usePermission('settings.edit');

  const { data, isLoading } = useQuery<TransferSettings>({
    queryKey: ['admin-transfer-settings'],
    queryFn: async () => (await api.get('/admin/settings/transfers')).data,
  });

  useEffect(() => {
    if (!data) return;
    const shaped: TransferSettings = {
      accept_all: !!data.accept_all,
      allowed_types: (data.allowed_types || []).map((tp) => ({
        mime: tp.mime,
        extensions: tp.extensions || [],
      })),
      max_size_mb: Number(data.max_size_mb) || 50,
    };
    setForm(shaped);
    setLoaded(shaped);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form) return;
      await api.put('/admin/settings/transfers', {
        accept_all: form.accept_all,
        allowed_types: form.allowed_types,
        max_size_mb: form.max_size_mb,
      });
    },
    onSuccess: () => {
      toast.success(t('settings.saved', 'Settings saved'));
      queryClient.invalidateQueries({ queryKey: ['admin-transfer-settings'] });
    },
    onError: (error) => {
      const msg = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || t('settings.saveError', 'Failed to save settings'));
    },
  });

  if (isLoading || !form) return <Loading />;

  const update = (patch: Partial<TransferSettings>) => setForm({ ...form, ...patch });

  const updateType = (index: number, patch: Partial<AllowedType>) => {
    const next = form.allowed_types.map((tp, i) => (i === index ? { ...tp, ...patch } : tp));
    update({ allowed_types: next });
  };

  return (
    <div className="space-y-6">
      {!canEdit && (
        <Card padding="md" className="bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p>{t('settings.transfers.readOnly', 'Only admins who can edit settings can change what clients may send.')}</p>
          </div>
        </Card>
      )}
      <fieldset disabled={!canEdit} className="space-y-6 min-w-0">
      <Card className="p-6">
        <h3 className="mb-1 text-lg font-semibold text-heading">
          {t('settings.transfers.uploadsTitle', 'What clients may send you')}
        </h3>
        <p className="mb-5 text-sm text-soft">
          {t('settings.transfers.uploadsIntro',
            'Applies to file requests and to files you attach to a transfer. It does not change what may be uploaded to a gallery.')}
        </p>

        {/* Accept-all first: it decides whether the list below matters at all. */}
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line p-3">
          <input
            type="checkbox"
            checked={form.accept_all}
            onChange={(e) => update({ accept_all: e.target.checked })}
            className="mt-0.5 rounded"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-body">
              {t('settings.transfers.acceptAll', 'Accept all file types')}
            </span>
            <span className="mt-1 block text-xs text-soft">
              {t('settings.transfers.acceptAllHint',
                'Any file a client picks is accepted. The size limit, file count and link expiry still apply.')}
            </span>
          </span>
        </label>

        {form.accept_all && (
          <p className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t('settings.transfers.acceptAllWarning',
                'Uploaded files are stored and delivered as opaque downloads. PicPeak never opens, renders or scans them, and they are never served as web content — but it also cannot tell you whether one is safe. Check anything you open or pass on.')}
            </span>
          </p>
        )}

        <div className={`mt-6 ${form.accept_all ? 'opacity-50' : ''}`}>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-body">
              {t('settings.transfers.allowedTypes', 'Allowed file types')}
            </label>
            <Button
              size="sm"
              variant="outline"
              leftIcon={<Plus className="h-4 w-4" />}
              disabled={form.accept_all}
              onClick={() => update({ allowed_types: [...form.allowed_types, { mime: '', extensions: [] }] })}
            >
              {t('settings.transfers.addType', 'Add type')}
            </Button>
          </div>
          <p className="mb-3 text-xs text-soft">
            {t('settings.transfers.allowedTypesHint',
              'A file is accepted when its type matches and its extension is one of the listed ones. Leave the extensions empty to match on the type alone.')}
          </p>

          {form.allowed_types.length === 0 ? (
            <p className="text-sm text-muted">
              {t('settings.transfers.noTypes', 'No types listed. Add at least one, or turn on "Accept all file types".')}
            </p>
          ) : (
            <div className="space-y-2">
              {form.allowed_types.map((tp, index) => (
                <div key={index} className="flex items-start gap-2">
                  <Input
                    aria-label={t('settings.transfers.mime', 'File type')}
                    className="flex-1"
                    placeholder="image/svg+xml"
                    value={tp.mime}
                    disabled={form.accept_all}
                    onChange={(e) => updateType(index, { mime: e.target.value.trim().toLowerCase() })}
                  />
                  <Input
                    aria-label={t('settings.transfers.extensions', 'Extensions')}
                    className="flex-1"
                    placeholder=".svg"
                    value={extensionsToText(tp.extensions)}
                    disabled={form.accept_all}
                    onChange={(e) => updateType(index, { extensions: textToExtensions(e.target.value) })}
                  />
                  <button
                    type="button"
                    disabled={form.accept_all}
                    onClick={() => update({ allowed_types: form.allowed_types.filter((_, i) => i !== index) })}
                    className="rounded p-2 text-muted hover:bg-hover hover:text-red-600 disabled:opacity-40"
                    title={t('common.remove', 'Remove')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 max-w-xs">
          <Input
            type="number"
            min={1}
            label={t('settings.transfers.maxSize', 'Maximum file size (MB)')}
            value={String(form.max_size_mb)}
            onChange={(e) => update({ max_size_mb: parseInt(e.target.value, 10) || 0 })}
          />
          <p className="mt-1 text-xs text-soft">
            {t('settings.transfers.maxSizeHint', 'Applies per file, not per upload.')}
          </p>
        </div>
      </Card>

      </fieldset>

      <SettingsSaveBar
        isDirty={isDirty}
        isSaving={saveMutation.isPending}
        onSave={() => saveMutation.mutate()}
        onDiscard={() => setForm(loaded)}
        canSave={canEdit
          && form.max_size_mb >= 1
          && (form.accept_all || form.allowed_types.some((tp) => tp.mime.includes('/')))}
      />
    </div>
  );
};
