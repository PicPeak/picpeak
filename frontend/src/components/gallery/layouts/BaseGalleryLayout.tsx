import React from 'react';
import type { Photo, DownloadResolutionChoice, GalleryPerson } from '../../../types';

export interface BaseGalleryLayoutProps {
  photos: Photo[];
  // People in this gallery (#1074) — forwarded by PhotoGridWithLayouts so
  // full-page layouts, which render their OWN lightbox, can still show the
  // "In this photo" chips.
  people?: GalleryPerson[];
  onSelectPerson?: (personId: number) => void;
  slug: string;
  onPhotoClick: (index: number) => void;
  // Optional: open the lightbox with feedback panel visible
  onOpenPhotoWithFeedback?: (index: number) => void;
  // Notify parent that feedback (like/favorite/rating/comment) changed
  onFeedbackChange?: () => void;
  onDownload: (photo: Photo, e: React.MouseEvent) => void;
  selectedPhotos?: Set<number>;
  isSelectionMode?: boolean;
  onPhotoSelect?: (photoId: number) => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  eventName?: string;
  eventLogo?: string | null;
  eventDate?: string | null;
  expiresAt?: string | null;
  allowDownloads?: boolean;
  /** #1160: folder-only root — render the shell, skip the empty message. */
  suppressEmptyState?: boolean;
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
  // Resolution picker choices (#858). More than one entry means the gallery
  // offers a real choice, so bulk downloads must route through the modal
  // instead of calling downloadSelectedPhotos directly.
  downloadChoices?: DownloadResolutionChoice[];
  onPickResolution?: (photoIds: number[]) => void;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
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
