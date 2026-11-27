/**
 * Image picker of the website builder (issue 2618): uploads made in the
 * builder, and photos of galleries that are on the website. A gallery that is
 * not shows why (not opted in, password, expired …) and, for its owner, the
 * switch that opts it in. Nothing else of a client gallery is offered.
 */
import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Check, Film, Images, Trash2, Upload } from 'lucide-react';
import { Button, Modal, Notice, Switch, Tabs } from '../../components/common';
import { EmptyState } from '../../components/common/EmptyState';
import { useConfirm } from '../../components/common/ConfirmDialog';
import { AdminAuthenticatedImage } from '../../components/admin/AdminAuthenticatedImage';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { usePermission } from '../../hooks/usePermission';
import { websiteService } from '../../services/website.service';
import { apiErrorText } from '../../utils/apiErrorText';
import { buildResourceUrl } from '../../utils/url';
import type { ImageRef, WebsiteAsset, WebsiteGallery } from './types';
import { SearchField, useDebounced } from './search';

type Source = 'uploads' | 'galleries';

interface ImagePickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (refs: ImageRef[]) => void;
  multiple?: boolean;
  /** Offer hero videos (uploads only) instead of images. */
  kind?: 'image' | 'video';
}

const tileClass = (selected: boolean) => `relative block w-full aspect-square overflow-hidden rounded-lg bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected ? 'tile-selected ring-2 ring-accent' : ''}`;

const SelectedMark: React.FC = () => (
  <span className="absolute top-1.5 right-1.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-accent-strong text-accent-fg shadow">
    <Check className="w-4 h-4" aria-hidden="true" />
  </span>
);

export const ImagePicker: React.FC<ImagePickerProps> = ({ open, onClose, onSelect, multiple = false, kind = 'image' }) => {
  const { t } = useTranslation();
  const [source, setSource] = useState<Source>('uploads');
  const [gallery, setGallery] = useState<WebsiteGallery | null>(null);
  const [selected, setSelected] = useState<ImageRef[]>([]);

  const close = () => {
    setSelected([]);
    setGallery(null);
    onClose();
  };

  const toggle = (ref: ImageRef) => {
    if (!multiple) {
      onSelect([ref]);
      close();
      return;
    }
    setSelected((list) => (list.some((r) => r.source === ref.source && r.id === ref.id)
      ? list.filter((r) => !(r.source === ref.source && r.id === ref.id))
      : [...list, ref]));
  };
  const isSelected = (ref: ImageRef) => selected.some((r) => r.source === ref.source && r.id === ref.id);

  const footer = multiple ? (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="secondary" onClick={close}>{t('common.cancel', 'Cancel')}</Button>
      <Button variant="primary" disabled={!selected.length} onClick={() => { onSelect(selected); close(); }}>
        {t('website.picker.addSelected', 'Add {{count}} images', { count: selected.length })}
      </Button>
    </div>
  ) : undefined;

  return (
    <Modal
      open={open}
      onClose={close}
      size="2xl"
      title={kind === 'video' ? t('website.picker.videoTitle', 'Choose a video') : t('website.picker.title', 'Choose images')}
      description={kind === 'video'
        ? t('website.picker.videoDescription', 'An MP4 up to two minutes. It plays muted and in a loop.')
        : t('website.picker.description', 'Upload images for the website, or pick photos from galleries you put on the website.')}
      footer={footer}
    >
      {kind === 'image' && (
        <Tabs<Source>
          className="mb-4"
          value={source}
          onChange={(next) => { setSource(next); setGallery(null); }}
          items={[
            { id: 'uploads', label: t('website.picker.uploads', 'Uploads'), icon: <Upload className="w-4 h-4" /> },
            { id: 'galleries', label: t('website.picker.galleries', 'Galleries'), icon: <Images className="w-4 h-4" /> },
          ]}
        />
      )}
      {source === 'uploads' || kind === 'video'
        ? <UploadsPane kind={kind} isSelected={isSelected} onToggle={toggle} />
        : gallery
          ? <GalleryPhotosPane gallery={gallery} onBack={() => setGallery(null)} isSelected={isSelected} onToggle={toggle} />
          : <GalleriesPane onOpen={setGallery} />}
    </Modal>
  );
};

export const UploadsPane: React.FC<{ kind: 'image' | 'video'; isSelected: (ref: ImageRef) => boolean; onToggle: (ref: ImageRef) => void }> = ({ kind, isSelected, onToggle }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const canEdit = usePermission('cms.edit');
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const assets = useInfiniteQuery({
    queryKey: ['website-assets', kind, q],
    // A new search keeps the old list on screen until its answer arrives.
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => websiteService.listAssets({ page: pageParam, q, kind }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasMore ? all.length + 1 : undefined),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        // One upload at a time keeps the server's image work serial.
        await websiteService.uploadAsset(file);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['website-assets'] }),
    onError: (err) => {
      toast.error(apiErrorText(err));
      queryClient.invalidateQueries({ queryKey: ['website-assets'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => websiteService.deleteAsset(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['website-assets'] }),
    onError: (err) => toast.error(apiErrorText(err)),
  });

  const list = (assets.data?.pages || []).flatMap((p) => p.assets);
  const askRemove = async (asset: WebsiteAsset) => {
    const ok = await confirm({
      title: t('website.picker.deleteTitle', 'Delete this upload?'),
      message: t('website.picker.deleteMessage', 'It is removed for good. An upload still used on a page cannot be deleted.'),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    });
    if (ok) remove.mutate(asset.id);
  };

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            className="hidden"
            multiple={kind === 'image'}
            accept={kind === 'video' ? 'video/mp4' : 'image/jpeg,image/png,image/webp,image/gif'}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              if (files.length) upload.mutate(files);
            }}
          />
          <Button variant="secondary" leftIcon={<Upload className="w-4 h-4" />} isLoading={upload.isPending} onClick={() => input.current?.click()}>
            {kind === 'video' ? t('website.picker.uploadVideo', 'Upload video') : t('website.picker.upload', 'Upload images')}
          </Button>
          <span className="text-xs text-muted">
            {kind === 'video'
              ? t('website.picker.videoHint', 'MP4, up to 100 MB. Location and device data are removed.')
              : t('website.picker.uploadHint', 'JPEG, PNG, WebP or GIF, up to 30 MB. Location data is removed; the original is not kept.')}
          </span>
        </div>
      )}
      <SearchField value={search} onChange={setSearch} label={t('website.picker.searchUploads', 'Search by file name')} />
      {assets.isLoading ? (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {Array.from({ length: 10 }, (_, i) => <div key={i} className="aspect-square rounded-lg bg-fill animate-pulse" />)}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          size="inline"
          icon={kind === 'video' ? <Film className="w-6 h-6" aria-hidden="true" /> : <Upload className="w-6 h-6" aria-hidden="true" />}
          title={kind === 'video' ? t('website.picker.noVideos', 'No videos uploaded yet') : t('website.picker.noUploads', 'No uploads yet')}
          description={t('website.picker.noUploadsHint', 'Upload files here that you only want on the website.')}
        />
      ) : (
        <ul className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {list.map((asset) => {
            const ref: ImageRef = { source: 'asset', id: asset.id };
            const label = asset.originalFilename || asset.id;
            return (
              <li key={asset.id} className="relative group">
                <button type="button" className={tileClass(isSelected(ref))} onClick={() => onToggle(ref)} aria-pressed={isSelected(ref)} aria-label={label}>
                  {asset.previewUrl
                    ? <img src={buildResourceUrl(asset.previewUrl)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    : <span className="flex w-full h-full items-center justify-center text-faint"><Film className="w-8 h-8" aria-hidden="true" /></span>}
                  {isSelected(ref) && <SelectedMark />}
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => askRemove(asset)}
                    className="absolute bottom-1.5 right-1.5 inline-flex w-7 h-7 items-center justify-center rounded-md bg-panel text-soft shadow opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger-text"
                    aria-label={t('website.picker.deleteLabel', 'Delete {{name}}', { name: label }) as string}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {assets.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" isLoading={assets.isFetchingNextPage} onClick={() => assets.fetchNextPage()}>{t('website.picker.more', 'Show more')}</Button>
        </div>
      )}
    </div>
  );
};

const REASONS: Record<string, string> = {
  unavailable: 'Expired, a draft or switched off',
  hidden: 'Not revealed yet',
  payment_lock: 'Waiting for payment',
};

export const GalleriesPane: React.FC<{ onOpen: (gallery: WebsiteGallery) => void }> = ({ onOpen }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const canEditEvents = usePermission('events.edit');
  const canEditSite = usePermission('cms.edit');
  const canChange = canEditEvents && canEditSite;
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const galleries = useInfiniteQuery({
    queryKey: ['website-galleries', 'picker', q],
    // A new search keeps the old list on screen until its answer arrives.
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => websiteService.listGalleries({ page: pageParam, q }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasMore ? all.length + 1 : undefined),
  });
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) => websiteService.setGalleryOnWebsite(id, on),
    onSuccess: () => {
      // The preview and the picked images' thumbnails show which galleries
      // are on the website too, not only this list.
      void queryClient.invalidateQueries({ queryKey: ['website-galleries'] });
      void queryClient.invalidateQueries({ queryKey: ['website-media'] });
      void queryClient.invalidateQueries({ queryKey: ['website-preview'] });
    },
    onError: (err) => toast.error(apiErrorText(err)),
  });
  const [onSite, others] = useMemo(() => {
    const list = (galleries.data?.pages || []).flatMap((p) => p.galleries);
    return [list.filter((g) => g.showOnWebsite), list.filter((g) => !g.showOnWebsite)];
  }, [galleries.data]);

  const row = (g: WebsiteGallery) => (
    <li key={g.id} className="flex flex-wrap items-center gap-3 py-2.5">
      <div className="flex-1 min-w-0">
        {g.eligible ? (
          <button type="button" className="text-sm font-medium text-heading hover:text-accent text-left" onClick={() => onOpen(g)}>
            {g.name}
          </button>
        ) : <span className="text-sm font-medium text-heading">{g.name}</span>}
        <p className="text-xs text-muted">
          {g.date ? format(g.date) : ''}
          {g.showOnWebsite && !g.eligible && g.reason ? ` · ${t(`website.picker.reason.${g.reason}`, REASONS[g.reason] || g.reason)}` : ''}
        </p>
        {g.hasPassword && (
          <p className="text-xs text-warning-text">
            {t('website.picker.passwordNote', 'Has a password. On the website, the photos you pick are public; the rest of the gallery keeps its password.')}
          </p>
        )}
      </div>
      {g.eligible && (
        <Button size="sm" variant="ghost" onClick={() => onOpen(g)}>{t('website.picker.openGallery', 'Choose photos')}</Button>
      )}
      {canChange && g.canChange && (
        <Switch
          size="sm"
          checked={g.showOnWebsite}
          disabled={toggle.isPending}
          onChange={(on) => toggle.mutate({ id: g.id, on })}
          ariaLabel={t('website.picker.showOnWebsite', 'Show “{{name}}” on the website', { name: g.name }) as string}
        />
      )}
    </li>
  );

  return (
    <div className="space-y-4">
      <SearchField value={search} onChange={setSearch} label={t('website.picker.searchGalleries', 'Search galleries by name')} />
      <Notice tone="info" size="sm">
        {t('website.picker.galleriesNotice', 'Only galleries you put on the website can be used, and only while they are live. Putting a gallery on the website makes the photos you pick public, even when the gallery has a password; its other photos stay private. Turn a gallery off here and its photos leave the website at once.')}
      </Notice>
      {galleries.isLoading ? <div className="h-40 rounded-lg bg-fill animate-pulse" /> : (
        <>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">{t('website.picker.onWebsite', 'On the website')}</h3>
            {onSite.length ? <ul className="divide-y divide-line">{onSite.map(row)}</ul>
              : <p className="text-sm text-muted py-2">{q
                ? t('website.picker.noMatch', 'No gallery on the website matches.')
                : t('website.picker.noneOnWebsite', 'No gallery is on the website yet.')}</p>}
          </section>
          {others.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">{t('website.picker.otherGalleries', 'Other galleries')}</h3>
              <ul className="divide-y divide-line">{others.map(row)}</ul>
            </section>
          )}
          {galleries.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" isLoading={galleries.isFetchingNextPage} onClick={() => galleries.fetchNextPage()}>{t('website.picker.more', 'Show more')}</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const GalleryPhotosPane: React.FC<{
  gallery: WebsiteGallery;
  onBack: () => void;
  isSelected: (ref: ImageRef) => boolean;
  onToggle: (ref: ImageRef) => void;
}> = ({ gallery, onBack, isSelected, onToggle }) => {
  const { t } = useTranslation();
  const photos = useInfiniteQuery({
    queryKey: ['website-gallery-photos', gallery.id],
    queryFn: ({ pageParam }) => websiteService.listGalleryPhotos(gallery.id, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasMore ? all.length + 1 : undefined),
  });
  const list = (photos.data?.pages || []).flatMap((p) => p.photos);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" leftIcon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>{t('website.picker.back', 'All galleries')}</Button>
        <span className="text-sm font-medium text-heading truncate">{gallery.name}</span>
      </div>
      {photos.isLoading ? (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {Array.from({ length: 10 }, (_, i) => <div key={i} className="aspect-square rounded-lg bg-fill animate-pulse" />)}
        </div>
      ) : (
        <ul className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {list.map((photo) => {
            const ref: ImageRef = { source: 'photo', id: photo.id };
            return (
              <li key={photo.id}>
                <button type="button" className={tileClass(isSelected(ref))} onClick={() => onToggle(ref)} aria-pressed={isSelected(ref)} aria-label={photo.filename}>
                  <AdminAuthenticatedImage src={photo.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                  {isSelected(ref) && <SelectedMark />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {photos.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" isLoading={photos.isFetchingNextPage} onClick={() => photos.fetchNextPage()}>{t('website.picker.more', 'Show more')}</Button>
        </div>
      )}
    </div>
  );
};
