import React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Loading, Modal, Notice } from '../common';
import { photosService } from '../../services/photos.service';

interface VideoPosterPickerProps {
  open: boolean;
  onClose: () => void;
  eventId: number;
  photoId: number;
  /** Called once the poster was rebuilt at the chosen frame. */
  onChanged: () => void;
}

/** `m:ss.s`, the way a player shows a position. */
export function formatPosterOffset(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

// The stored pick is rounded to the millisecond, like the offered frames.
const sameFrame = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.0005;

/**
 * The admin picks a video's preview image from three frames taken on request
 * (issue 2263, item 4), or goes back to the default frame.
 */
export const VideoPosterPicker: React.FC<VideoPosterPickerProps> = ({ open, onClose, eventId, photoId, onChanged }) => {
  const { t } = useTranslation();
  // Taken fresh each time the picker opens: the frames are not stored.
  const candidatesQuery = useQuery({
    queryKey: ['admin-video-poster-candidates', eventId, photoId],
    queryFn: () => photosService.getPosterCandidates(eventId, photoId),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (offset: number | null) => photosService.setPosterOffset(eventId, photoId, offset),
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });

  const data = candidatesQuery.data;
  const current = data?.poster_offset_seconds ?? null;
  const defaultTime = formatPosterOffset(data?.default_offset_seconds ?? 1);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('admin.photos.poster.title')}
      description={t('admin.photos.poster.description')}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => save.mutate(null)}
            disabled={!data || current === null || save.isPending}
            isLoading={save.isPending && save.variables === null}
          >
            {t('admin.photos.poster.useDefault')}
          </Button>
        </>
      )}
    >
      {candidatesQuery.isLoading && (
        <div className="py-8 flex flex-col items-center gap-3 text-muted text-sm">
          <Loading size="md" />
          {t('admin.photos.poster.loading')}
        </div>
      )}

      {candidatesQuery.isError && (
        <Notice
          tone="danger"
          action={(
            <Button variant="outline" size="sm" onClick={() => candidatesQuery.refetch()}>
              {t('admin.photos.poster.retry')}
            </Button>
          )}
        >
          {(candidatesQuery.error as { response?: { data?: { error?: string } } })?.response?.data?.error
            || t('admin.photos.poster.loadError')}
        </Notice>
      )}

      {data && (
        <div className="space-y-4">
          <p className="text-sm text-body flex items-center gap-2">
            <Badge tone="accent">{t('admin.photos.poster.current')}</Badge>
            {current === null
              ? t('admin.photos.poster.isDefault')
              : t('admin.photos.poster.isPicked', { time: formatPosterOffset(current) })}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {data.candidates.map((candidate) => {
              const isCurrent = sameFrame(candidate.offset_seconds, current);
              const time = formatPosterOffset(candidate.offset_seconds);
              return (
                <button
                  key={candidate.offset_seconds}
                  type="button"
                  onClick={() => save.mutate(candidate.offset_seconds)}
                  disabled={save.isPending || isCurrent}
                  aria-pressed={isCurrent}
                  aria-label={t('admin.photos.poster.frameAt', { time })}
                  className={`relative rounded-lg border-2 p-1 bg-panel text-left transition-colors disabled:cursor-default ${
                    isCurrent ? 'border-accent' : 'border-line hover:border-line-strong'
                  }`}
                >
                  <img
                    src={candidate.image}
                    alt=""
                    className="w-full aspect-video object-contain rounded bg-inset"
                  />
                  <span className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                    {time}
                    {isCurrent && <Badge tone="accent">{t('admin.photos.poster.current')}</Badge>}
                  </span>
                  {save.isPending && save.variables === candidate.offset_seconds && (
                    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/30">
                      <Loading size="sm" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <p className="text-xs text-muted">{t('admin.photos.poster.defaultHint', { time: defaultTime })}</p>
        </div>
      )}

      {save.isError && (
        <Notice tone="danger" className="mt-4">
          {(save.error as { response?: { data?: { error?: string } } })?.response?.data?.error
            || t('admin.photos.poster.saveError')}
        </Notice>
      )}
    </Modal>
  );
};
