import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Heart } from 'lucide-react';
import { format, startOfDay, startOfWeek, startOfMonth } from 'date-fns';
import { useTheme } from '../../../contexts/ThemeContext';
import { PhotoCard } from '../PhotoCard';
import { firstLookAboveChips } from '../GalleryTileBadges';
import { ClientVisibilityToggle, isHiddenFromGuests } from '../ClientVisibilityToggle';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { useLazyBands } from './lazyBands';
import { densityColumnDelta, useGridDensity } from '../gridDensity';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { toDisplayDate, useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { WINDOW_MIN_PHOTOS } from './rowWindow';
import { GRID_TILE_ATTR, TIMELINE_GROUP_WINDOW_MIN_PHOTOS, useGridWindow } from './gridWindow';

const GRID_TILE_PROPS = { [GRID_TILE_ATTR]: '' } as React.HTMLAttributes<HTMLDivElement>;

/**
 * One date group's grid. In a large gallery each group mounts only its rows
 * near the viewport (issue 2193); the date headers between them stay mounted.
 */
const TimelineGroupGrid: React.FC<{
  photos: Photo[];
  /** The grid's classes, its columns moved by the viewer's density. */
  className: string;
  windowed: boolean;
  renderTile: (photo: Photo) => React.ReactNode;
}> = ({ photos, className, windowed, renderTile }) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const { tiles, before, after } = useGridWindow(gridRef, photos, windowed);
  return (
    <div ref={gridRef} className={className}>
      {before > 0 && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: before }} />}
      {tiles.map(({ photo }) => renderTile(photo))}
      {after > 0 && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: after }} />}
    </div>
  );
};

export const TimelineGalleryLayout: React.FC<BaseGalleryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick,
  onOpenPhotoWithFeedback,
  onDownload,
  selectedPhotos = new Set(),
  isSelectionMode = false,
  onPhotoSelect,
  allowDownloads = true,
  feedbackEnabled = false,
  feedbackOptions,
  isClient = false,
  onToggleVisibility,
}) => {
  const bands = useLazyBands();
  const { theme } = useTheme();
  const { formatTime: fmtTime } = useLocalizedDate();
  // The timeline's fixed 2/3/4 columns, moved by the viewer's density (issue
  // 1733, E4). The grid-cols classes are safelisted in tailwind.config.
  const delta = densityColumnDelta(useGridDensity());
  const cols = (base: number) => Math.max(1, base + delta);
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  // Seed from server is_liked on first non-empty payload (#590 follow-up).
  // Mount-only so refetches don't clobber in-session optimistic toggles.
  const likedSeededRef = useRef(false);
  useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const gallerySettings = theme.gallerySettings || {};
  const grouping = gallerySettings.timelineGrouping || 'day';
  const showDates = gallerySettings.timelineShowDates !== false;
  const canQuickComment = Boolean(feedbackEnabled && feedbackOptions?.allowComments && onOpenPhotoWithFeedback);

  // Tolerant timestamp parse: SQLite installs can hold epoch numbers in
  // uploaded_at (pre-fix archive restores) — parseISO throws on numbers
  // and crashed the whole Timeline view (#485 class). The API normalizes
  // to ISO now; this guard covers stale caches and old backends.
  // Strings go through the date hook's parser, so SQLite's zone-less
  // 'YYYY-MM-DD HH:MM:SS' is read as UTC here exactly as the time chip reads
  // it; a local reading filed a photo under a different day than its chip
  // shows (issue 1815).
  const parseUploadedAt = (value: string | number) =>
    typeof value === 'string' ? toDisplayDate(value) : new Date(value);

  // Group photos by date
  const groupedPhotos = useMemo(() => {
    const groups = new Map<string, Photo[]>();
    
    photos.forEach(photo => {
      const date = parseUploadedAt(photo.uploaded_at);
      let groupKey: string;
      
      switch (grouping) {
        case 'week':
          const weekStart = startOfWeek(date);
          groupKey = format(weekStart, 'yyyy-MM-dd');
          // groupLabel = `Week of ${format(weekStart, 'MMM d, yyyy')}`;
          break;
        case 'month':
          const monthStart = startOfMonth(date);
          groupKey = format(monthStart, 'yyyy-MM');
          // groupLabel = format(monthStart, 'MMMM yyyy');
          break;
        default: // day
          const dayStart = startOfDay(date);
          groupKey = format(dayStart, 'yyyy-MM-dd');
          // groupLabel = format(dayStart, 'EEEE, MMMM d, yyyy');
      }
      
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(photo);
    });
    
    // Convert to array and sort by date
    return Array.from(groups.entries())
      .map(([date, photos]) => ({
        date,
        label: photos[0] ? format(parseUploadedAt(photos[0].uploaded_at), grouping === 'month' ? 'MMMM yyyy' : grouping === 'week' ? "'Week of' MMM d, yyyy" : 'EEEE, MMMM d, yyyy') : date,
        photos: photos.sort((a, b) => parseUploadedAt(b.uploaded_at).getTime() - parseUploadedAt(a.uploaded_at).getTime())
      }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [photos, grouping]);

  // Position of each photo in `photos`, which is what the lightbox indexes
  // by. Grouping reorders the tiles, and a `findIndex` per tile made every
  // render of an N-photo gallery O(N²) (issue 1733).
  const photoIndexById = useMemo(() => {
    const map = new Map<number, number>();
    photos.forEach((photo, index) => map.set(photo.id, index));
    return map;
  }, [photos]);

  return (
    <div className="relative">
      {/* Timeline line */}
      <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-black/20 hidden lg:block" />
      
      {/* Timeline groups */}
      <div className="space-y-12">
        {groupedPhotos.map((group) => (
          <div key={group.date} className="relative">
            {/* Date marker */}
            {showDates && (
              <div className="flex items-center gap-4 mb-6">
                <div className="hidden lg:flex items-center justify-center w-16 h-16 bg-surface border-4 border-accent-dark rounded-full z-10">
                  <Calendar className="w-6 h-6 text-accent" />
                </div>
                <h3 className="text-xl font-semibold text-theme">
                  {group.label}
                </h3>
              </div>
            )}
            
            {/* Photos grid for this date */}
            <TimelineGroupGrid
              photos={group.photos}
              className={`photo-grid lg:ml-24 grid grid-cols-${cols(2)} sm:grid-cols-${cols(3)} lg:grid-cols-${cols(4)} gap-4`}
              windowed={photos.length >= WINDOW_MIN_PHOTOS && group.photos.length >= TIMELINE_GROUP_WINDOW_MIN_PHOTOS}
              renderTile={(photo) => {
                const actualIndex = photoIndexById.get(photo.id) ?? -1;
                return (
                  <PhotoCard
                    key={photo.id}
                    // Above the always-present time chip (issue 1562).
                    firstLookClassName={firstLookAboveChips(photo.type === 'collage' ? 2 : 1)}
                    photo={photo}
                    isSelected={selectedPhotos.has(photo.id)}
                    isSelectionMode={isSelectionMode}
                    onClick={() => onPhotoClick(actualIndex)}
                    onDownload={(e) => onDownload(photo, e)}
                    onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
                    className="photo-card relative group cursor-pointer aspect-square"
                    // Issue 1733: skip offscreen tile work, as in Grid — the
                    // `aspect-square` box needs no intrinsic size.
                    style={{ contentVisibility: 'auto' }}
                    // Lazy mount + release with Grid's bands (issue 1733).
                    // AuthenticatedImage fetches on mount, so without `lazy`
                    // every tile of the gallery was requested on first render.
                    lazy
                    inViewRootMargin={bands.load}
                    releaseRootMargin={bands.keep}
                    imageProps={{
                      src: photo.thumbnail_url || photo.url,
                      alt: photo.filename,
                      // Dimmed when the client hid it from guests, as in Grid (issue 1992).
                      className: `w-full h-full object-cover rounded-lg${isClient && onToggleVisibility && isHiddenFromGuests(photo) ? ' opacity-40' : ''}`,
                      loading: 'lazy',
                      isGallery: true,
                    }}
                    overlayBaseClassName="absolute inset-0 bg-black/40 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2"
                    allowDownloads={allowDownloads}
                    feedbackEnabled={feedbackEnabled}
                    feedbackOptions={feedbackOptions}
                    slug={slug}
                    onQuickComment={canQuickComment ? () => onOpenPhotoWithFeedback?.(actualIndex) : undefined}
                    liked={likedIds.has(photo.id)}
                    onLikeSuccess={() => {
                      // Toggle — server /feedback like is a toggle (#590).
                      setLikedIds(prev => {
                        const next = new Set(prev);
                        if (next.has(photo.id)) next.delete(photo.id);
                        else next.add(photo.id);
                        return next;
                      });
                    }}
                    savedIdentity={savedIdentity}
                    onIdentitySaved={setSavedIdentity}
                    onRequireIdentity={(action, photoId) => {
                      setPendingAction({ type: action, photoId });
                      setShowIdentityModal(true);
                    }}
                    likeBeforeComment
                    checkboxTestId
                    containerProps={GRID_TILE_PROPS}
                    topLeftControl={isClient && onToggleVisibility
                      ? <ClientVisibilityToggle photo={photo} onToggle={onToggleVisibility} />
                      : undefined}
                    beforeOverlay={
                      <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded">
                        {fmtTime(photo.uploaded_at)}
                      </div>
                    }
                    afterOverlay={((photo.like_count ?? 0) > 0 || likedIds.has(photo.id)) ? (
                      <div className={`absolute ${photo.type === 'collage' ? 'bottom-8' : 'bottom-2'} left-2 z-10`}>
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Liked">
                          <Heart className="w-3.5 h-3.5 text-danger" fill="currentColor" />
                        </span>
                      </div>
                    ) : undefined}
                  />
                );
              }}
            />
          </div>
        ))}
      </div>
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
        onSubmit={async (name, email) => {
          setSavedIdentity({ name, email });
          setShowIdentityModal(false);
          if (pendingAction) {
            await feedbackService.submitFeedback(slug!, String(pendingAction.photoId), {
              feedback_type: pendingAction.type,
              guest_name: name,
              guest_email: email,
            });
            setPendingAction(null);
          }
        }}
        feedbackType="like"
      />
    </div>
  );
};
