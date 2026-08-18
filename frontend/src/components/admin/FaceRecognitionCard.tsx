/**
 * <FaceRecognitionCard>
 *
 * Per-event "People in this gallery" controls (#1074). Only rendered when the
 * `faces` feature flag is on — see OverviewTab.
 *
 * Two toggles, deliberately separate:
 *   - Detect people: the actual processing switch. Off by default.
 *   - Show to guests: whether the people bar reaches the gallery. On by
 *     default once detection is on, but a photographer may want clustering
 *     as a private sorting tool without changing what clients see.
 *
 * Face embeddings are biometric data (GDPR Art. 9 in the EU, where much of
 * this user base operates). The consent paragraph is not boilerplate — we
 * provide the switch, the photographer provides the lawful basis — so it
 * renders next to the toggle rather than behind a "learn more".
 */
import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Users, RefreshCw, Trash2, AlertTriangle, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { PeopleManagerModal } from './PeopleManagerModal';

import { Button, Card, Loading } from '../common';
import { api } from '../../config/api';

interface FacesPayload {
  enabled: boolean;
  visible_to_guests: boolean;
  last_scan_at: string | null;
  status: {
    scanned: number;
    total: number;
    pending: number;
    failed: number;
    people: number;
    // What guests actually see: the minimum-cluster-size floor and the
    // hidden/ignored flags applied. Usually lower than `people`.
    people_visible_to_guests?: number;
    in_progress: boolean;
  };
}

interface FaceRecognitionCardProps {
  eventId: number;
  isArchived?: boolean;
}

export const FaceRecognitionCard: React.FC<FaceRecognitionCardProps> = ({ eventId, isArchived }) => {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [autoCategories, setAutoCategories] = useState(false);

  const { data, isLoading, refetch } = useQuery<FacesPayload>({
    queryKey: ['admin-event-faces', eventId],
    queryFn: async () => (await api.get(`/admin/events/${eventId}/faces`)).data,
    // Poll while a scan is running so the status line advances without a
    // manual refresh; stop entirely once it settles.
    refetchInterval: (query) => (query.state.data?.status?.in_progress ? 5000 : false),
  });

  useEffect(() => {
    if (!data?.enabled) return;
    api.get('/admin/events/faces/auto-categories')
      .then((r) => setAutoCategories(!!r.data?.enabled))
      .catch(() => { /* pre-migration or no permission — leave off */ });
  }, [data?.enabled]);

  const patch = async (body: Record<string, boolean>) => {
    setSaving(true);
    try {
      const { data: result } = await api.patch(`/admin/events/${eventId}/faces`, body);
      await refetch();
      if (result?.queued) {
        toast.success(t('admin.faces.queued', {
          count: result.queued,
          defaultValue: `Scanning ${result.queued} photos for people…`,
        }));
      } else {
        toast.success(t('common.saved', { defaultValue: 'Saved' }));
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('common.saveFailed', { defaultValue: 'Save failed' }));
    } finally {
      setSaving(false);
    }
  };

  const action = async (path: string, successKey: string, fallback: string) => {
    setSaving(true);
    try {
      await api.post(`/admin/events/${eventId}/faces/${path}`);
      await refetch();
      toast.success(t(successKey, { defaultValue: fallback }));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || fallback);
    } finally {
      setSaving(false);
    }
  };

  const purge = async () => {
    // Irreversible and covers biometric data — a plain confirm is the least
    // this deserves.
    const ok = window.confirm(t('admin.faces.confirmDelete', {
      defaultValue: 'Delete all detected people and face data for this gallery? This cannot be undone. Photos are not affected.',
    }));
    if (!ok) return;

    setSaving(true);
    try {
      await api.delete(`/admin/events/${eventId}/faces`);
      await refetch();
      toast.success(t('admin.faces.deleted', { defaultValue: 'Face data deleted' }));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Delete failed');
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <Card><Loading /></Card>;
  }
  if (!data) return null;

  const { status } = data;

  return (
    <Card>
      <div className="flex items-start gap-3 mb-4">
        <Users className="text-neutral-400 mt-0.5" size={20} />
        <div>
          <h3 className="text-lg font-medium text-neutral-900">
            {t('admin.faces.title', { defaultValue: 'People in this gallery' })}
          </h3>
          <p className="text-sm text-neutral-500">
            {t('admin.faces.subtitle', {
              defaultValue: 'Group photos by the people in them, so guests can find and download their own.',
            })}
          </p>
        </div>
      </div>

      {/* Consent obligation. Stated plainly and up front, because by the time
          someone has switched this on they have already processed the data. */}
      <div className="flex gap-2 p-3 mb-4 rounded-lg bg-amber-50 border border-amber-100 text-sm text-amber-900">
        <ShieldCheck size={16} className="flex-shrink-0 mt-0.5" />
        <p>
          {t('admin.faces.consentNotice', {
            defaultValue:
              'Detected faces are personal data, and in the EU they count as a special category. You are the controller for this gallery: make sure you have a lawful basis for the people in these photos before switching this on. Nothing leaves your server — detection runs in your own container.',
          })}
        </p>
      </div>

      <label className="flex items-start gap-3 py-2 cursor-pointer">
        <input
          type="checkbox"
          checked={data.enabled}
          disabled={saving || isArchived}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="mt-1 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
        />
        <span>
          <span className="block text-sm font-medium text-neutral-800">
            {t('admin.faces.enable', { defaultValue: 'Detect people in this gallery' })}
          </span>
          <span className="block text-xs text-neutral-500">
            {t('admin.faces.enableHint', {
              defaultValue: 'Existing photos are scanned in the background. Faces and their numeric signatures are stored in your database; they are never included in backups or exports.',
            })}
          </span>
        </span>
      </label>

      {data.enabled && (
        <label className="flex items-start gap-3 py-2 cursor-pointer">
          <input
            type="checkbox"
            checked={data.visible_to_guests}
            disabled={saving || isArchived}
            onChange={(e) => patch({ visible_to_guests: e.target.checked })}
            className="mt-1 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
          />
          <span>
            <span className="block text-sm font-medium text-neutral-800">
              {t('admin.faces.visible', { defaultValue: 'Show the people bar to guests' })}
            </span>
            <span className="block text-xs text-neutral-500">
              {t('admin.faces.visibleHint', {
                defaultValue: 'Off means you get the grouping as a private tool and guests see an unchanged gallery.',
              })}
            </span>
          </span>
        </label>
      )}

      {/* The preview-tier cost. Scanning generates the lightbox preview for
          every photo that lacks one, which is real CPU and real disk — an
          admin deserves to know that before starting a 2,000-photo backfill
          rather than discovering it in their storage graph. */}
      {data.enabled && (
        <div className="flex gap-2 p-3 mt-3 rounded-lg bg-neutral-50 text-xs text-neutral-600">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-neutral-400" />
          <p>
            {t('admin.faces.previewNotice', {
              defaultValue: 'Scanning works on the preview-sized copy of each photo. Galleries that have not generated previews yet will create them during the first scan, which uses additional CPU and disk space.',
            })}
          </p>
        </div>
      )}

      {/* Auto-categories (#1074 phase 3). Global, not per-event, which is why
          it sits apart from the two toggles above. Without a control here the
          rule engine had no way to be switched on at all. */}
      {data.enabled && (
        <label className="flex items-start gap-3 py-2 mt-2 pt-3 border-t border-neutral-100 cursor-pointer">
          <input
            type="checkbox"
            checked={autoCategories}
            disabled={saving}
            onChange={async (e) => {
              const next = e.target.checked;
              setSaving(true);
              try {
                await api.put('/admin/events/faces/auto-categories', { enabled: next });
                setAutoCategories(next);
                toast.success(t('common.saved', { defaultValue: 'Saved' }));
              } catch (err: any) {
                toast.error(err?.response?.data?.error || t('common.saveFailed', { defaultValue: 'Save failed' }));
              } finally {
                setSaving(false);
              }
            }}
            className="mt-1 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
          />
          <span>
            <span className="block text-sm font-medium text-neutral-800">
              {t('admin.faces.autoCategories', { defaultValue: 'Sort photos into categories automatically' })}
            </span>
            <span className="block text-xs text-neutral-500">
              {t('admin.faces.autoCategoriesHint', {
                defaultValue: 'Uses the number of faces to file photos as Details, Portraits, Small groups or Groups. Applies to every gallery, only ever fills an empty category, and never changes one you set yourself.',
              })}
            </span>
          </span>
        </label>
      )}

      {data.enabled && (
        <>
          <div className="mt-4 pt-4 border-t border-neutral-100 text-sm text-neutral-600">
            {status.in_progress ? (
              <p className="flex items-center gap-2">
                <RefreshCw size={14} className="animate-spin text-primary-500" />
                {t('admin.faces.scanning', {
                  scanned: status.scanned,
                  total: status.total,
                  defaultValue: `Scanning… ${status.scanned} of ${status.total} photos`,
                })}
              </p>
            ) : (
              <p>
                {t('admin.faces.status', {
                  scanned: status.scanned,
                  total: status.total,
                  people: status.people,
                  defaultValue: `${status.scanned} / ${status.total} photos scanned · ${status.people} people`,
                })}
                {/* The gallery shows fewer: one-off appearances stay out of
                    the strip. Without both numbers an admin sees the settings
                    page and their own gallery disagree, with no explanation. */}
                {typeof status.people_visible_to_guests === 'number'
                  && status.people_visible_to_guests !== status.people && (
                  <span className="text-neutral-400">
                    {' '}
                    {t('admin.faces.visibleToGuests', {
                      count: status.people_visible_to_guests,
                      defaultValue: `(${status.people_visible_to_guests} shown to guests)`,
                    })}
                  </span>
                )}
                {status.failed > 0 && (
                  <span className="text-amber-600">
                    {' · '}
                    {t('admin.faces.failed', {
                      count: status.failed,
                      defaultValue: `${status.failed} failed`,
                    })}
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2 mt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => setManagerOpen(true)}
              leftIcon={<SlidersHorizontal size={14} />}
            >
              {t('admin.faces.manage', { defaultValue: 'Manage people' })}
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={saving || isArchived}
              onClick={() => action('rescan', 'admin.faces.rescanQueued', 'Re-scan queued')}
              leftIcon={<RefreshCw size={14} />}
            >
              {t('admin.faces.rescan', { defaultValue: 'Re-scan' })}
            </Button>

            {/* Cheap — re-derives people from data we already have, with no
                sidecar call. The button to reach for after changing the
                match threshold. */}
            <Button
              variant="outline"
              size="sm"
              disabled={saving || isArchived}
              onClick={() => action('recluster', 'admin.faces.reclustered', 'People regrouped')}
              leftIcon={<Users size={14} />}
            >
              {t('admin.faces.recluster', { defaultValue: 'Re-group people' })}
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={purge}
              leftIcon={<Trash2 size={14} />}
              className="text-red-600 border-red-200 hover:bg-red-50"
            >
              {t('admin.faces.delete', { defaultValue: 'Delete all face data' })}
            </Button>
          </div>

          <PeopleManagerModal
            eventId={eventId}
            open={managerOpen}
            onClose={() => setManagerOpen(false)}
            onChanged={() => refetch()}
          />
        </>
      )}
    </Card>
  );
};

export default FaceRecognitionCard;
