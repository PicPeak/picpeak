/**
 * <AutoTaggingCard>
 *
 * Per-gallery automatic scene tags (issue 1733). Only rendered while the
 * `autoTagging` feature flag is on. Like the faces card it acts immediately:
 * a switch, the queue's progress and a re-run are jobs, not draft settings.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { RefreshCw, Tags } from 'lucide-react';

import { Button, Card, Loading } from '../common';
import { api } from '../../config/api';

interface TaggingPayload {
  enabled: boolean;
  status: {
    tagged: number;
    total: number;
    pending: number;
    failed: number;
    skipped: number;
    in_progress: boolean;
  };
}

interface AutoTaggingCardProps {
  eventId: number;
  isArchived?: boolean;
  /** Without its own card frame, for a host that already draws one. */
  bare?: boolean;
}

export const AutoTaggingCard: React.FC<AutoTaggingCardProps> = ({ eventId, isArchived, bare = false }) => {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);

  const { data, isLoading, refetch } = useQuery<TaggingPayload>({
    queryKey: ['admin-event-tags', eventId],
    queryFn: async () => (await api.get(`/admin/events/${eventId}/tags`)).data,
    // Poll while the queue is moving; stop once it settles.
    refetchInterval: (query) => (query.state.data?.status?.in_progress ? 5000 : false),
  });

  const run = async (request: () => Promise<{ data: { queued?: number } }>) => {
    setSaving(true);
    try {
      const { data: result } = await request();
      await refetch();
      toast.success(result?.queued
        ? t('admin.tags.queued', { count: result.queued })
        : t('common.saved', { defaultValue: 'Saved' }));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('common.saveFailed', { defaultValue: 'Save failed' }));
    } finally {
      setSaving(false);
    }
  };

  const Frame = bare ? 'div' : Card;
  if (isLoading) return <Frame><Loading /></Frame>;
  if (!data) return null;
  const { status } = data;

  return (
    <Frame>
      <div className="flex items-start gap-3 mb-4">
        <Tags className="text-faint mt-0.5" size={20} />
        <div>
          <h3 className="text-lg font-medium text-heading">{t('admin.tags.title')}</h3>
          <p className="text-sm text-muted">{t('admin.tags.subtitle')}</p>
        </div>
      </div>

      <label className="flex items-start gap-3 py-2 cursor-pointer">
        <input
          type="checkbox"
          checked={data.enabled}
          disabled={saving || isArchived}
          onChange={(e) => run(() => api.patch(`/admin/events/${eventId}/tags`, { enabled: e.target.checked }))}
          className="mt-1 rounded border-line-strong bg-inset text-accent focus:ring-accent"
        />
        <span>
          <span className="block text-sm font-medium text-body">{t('admin.tags.enable')}</span>
          <span className="block text-xs text-muted">{t('admin.tags.enableHint')}</span>
        </span>
      </label>

      {data.enabled && (
        <>
          <div className="mt-4 pt-4 border-t border-line text-sm text-soft">
            {status.in_progress ? (
              <>
                <p className="flex items-center gap-2">
                  <RefreshCw size={14} className="animate-spin text-accent" />
                  {t('admin.tags.tagging', { tagged: status.tagged, total: status.total })}
                </p>
                {/* A queue that cannot reach the service does not fail, it
                    waits. Say what it is waiting for. */}
                <p className="mt-1 text-xs text-muted">{t('admin.tags.waitingHint')}</p>
              </>
            ) : (
              <p>
                {t('admin.tags.status', { tagged: status.tagged, total: status.total })}
                {status.failed > 0 && (
                  <span className="text-warning-text">
                    {' · '}
                    {t('admin.tags.failed', { count: status.failed })}
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2 mt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={saving || isArchived}
              onClick={() => run(() => api.post(`/admin/events/${eventId}/tags/rescan`))}
              leftIcon={<RefreshCw size={14} />}
            >
              {t('admin.tags.rescan')}
            </Button>
          </div>
        </>
      )}
    </Frame>
  );
};

export default AutoTaggingCard;
