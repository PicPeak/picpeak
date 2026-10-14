import React from 'react';
import type { Photo, DownloadResolutionChoice, GalleryPerson } from '../../../types';
import type { LightboxPhotoChangeHandler } from '../photoLink';
import type { QuotaPhoto } from '../../../utils/downloadLimit';

export interface BaseGalleryLayoutProps {
  photos: Photo[];
  /**
   * Link to a single photo (issue 1733). `openPhotoId` is the photo the URL
   * asks for (a deep link, or Back/Forward): a layout that mounts its own
   * lightbox opens it on that photo once it is in `photos`, and closes it on
   * null. `onLightboxPhotoChange` reports the lightbox's own moves back so
   * the container can mirror them to `?photo=`. Layouts that use the shared
   * lightbox in PhotoGridWithLayouts ignore both.
   */
  openPhotoId?: number | null;
  onLightboxPhotoChange?: LightboxPhotoChangeHandler;
  // People in this gallery (#1074) — forwarded by PhotoGridWithLayouts so
  // full-page layouts, which render their OWN lightbox, can still show the
  // "In this photo" chips.
  people?: GalleryPerson[];
  onSelectPerson?: (personId: number) => void;
  slug: string;
  onPhotoClick: (index: number) => void;
  // Optional: open the lightbox with feedback panel visible
  onOpenPhotoWithFeedback?: (index: number) => void;
  // Notify parent that feedback (like/favorite/rating/comment) changed. A
  // like or favourite toggle passes its photo id, so only that row is
  // refreshed instead of the whole list (issue 1891).
  onFeedbackChange?: (toggledPhotoId?: number) => void;
  onDownload: (photo: Photo, e: React.MouseEvent) => void;
  selectedPhotos?: Set<number>;
  isSelectionMode?: boolean;
  onPhotoSelect?: (photoId: number) => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  /**
   * Issue 1716: full-page layouts render their own selection chrome, so the
   * container hands them its mode toggle, an additive "select these ids"
   * (one state write, unlike calling onPhotoSelect in a loop, where every
   * call would read the same stale set) and its selection download, which
   * already routes through the resolution picker and the download limit.
   */
  onToggleSelectionMode?: () => void;
  onSelectMany?: (photoIds: number[]) => void;
  onDownloadSelected?: () => void | Promise<void>;
  /**
   * The whole selection as the download limit prices it, including photos a
   * search hides from `photos` (they stay selected and are downloaded).
   */
  selectionQuotaPhotos?: QuotaPhoto[];
  eventName?: string;
  eventLogo?: string | null;
  eventDate?: string | null;
  expiresAt?: string | null;
  allowDownloads?: boolean;
  /** #1160: folder-only root — render the shell, skip the empty message. */
  suppressEmptyState?: boolean;
  /** The scope has photos, but the search or filters leave none on screen. */
  emptyIsFiltered?: boolean;
  /**
   * Event-wide photo count (#1160), for stats a layout renders about the whole
   * gallery. `photos` is only the current folder scope and is empty at a
   * folder-only root.
   */
  eventPhotoCount?: number;
  /**
   * Runs the whole-gallery download (#1160). A layout's own "Download All
   * Photos" must use this rather than posting an id list: /download-selected
   * caps at 500 server-side, so a large gallery would silently truncate, while
   * /download-all has no such cap.
   */
  onDownloadEverything?: () => void;
  /**
   * Rendered right after the photos and before a layout's own footer — the
   * two-stage delivery banner (issue 1562), which has to follow the delivered
   * photos but must not land below "Powered by". Only the full-page layouts
   * read it; for the others PhotoGridWithLayouts renders it after the layout.
   */
  afterGrid?: React.ReactNode;
  // Copyable filename list (issue 1733, A3d), for layouts that own their
  // chrome: the selection, or the viewer's favourites. Hidden at zero.
  onCopyFilenames?: () => void;
  copyFilenamesCount?: number;
  /**
   * The nav heart of the full-page layouts: the gallery's "Liked" filter
   * (the viewer's own likes), owned by the container so `photos` already
   * arrives filtered. Absent, the heart is not a filter control.
   */
  likedOnly?: boolean;
  onToggleLikedOnly?: () => void;
  // Resolution picker choices (#858). More than one entry means the gallery
  // offers a real choice, so bulk downloads must route through the modal
  // instead of calling downloadSelectedPhotos directly.
  downloadChoices?: DownloadResolutionChoice[];
  onPickResolution?: (photoIds: number[]) => void;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  /** Canvas rendering applies to the lightbox only; tiles always render <img>. */
  useCanvasRendering?: boolean;
  feedbackEnabled?: boolean;
  feedbackOptions?: {
    allowLikes?: boolean;
    allowFavorites?: boolean;
    allowRatings?: boolean;
    allowComments?: boolean;
    allowReactions?: boolean;
    requireNameEmail?: boolean;
  };
  // Logout callback for full-page layouts
  onLogout?: () => void;
  // Guest upload for full-page layouts, which have no gallery header: opens
  // the container's upload dialog. Undefined when uploads are off.
  onUploadClick?: () => void;
  // Client visibility controls (#172)
  isClient?: boolean;
  onToggleVisibility?: (photoId: number, currentVisibility: string) => void;
  // Mirror of the admin original-filename toggle (#508). Forwarded to the
  // lightbox by layouts that mount their own (story/premium).
  showOriginalFilename?: boolean;
}

export abstract class BaseGalleryLayout<T extends BaseGalleryLayoutProps = BaseGalleryLayoutProps> extends React.Component<T> {
  abstract render(): React.ReactNode;
}
