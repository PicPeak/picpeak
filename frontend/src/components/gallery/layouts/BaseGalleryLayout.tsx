import React from 'react';
import type { Photo } from '../../../types';

export interface BaseGalleryLayoutProps {
  photos: Photo[];
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
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  feedbackEnabled?: boolean;
  feedbackOptions?: {
    allowLikes?: boolean;
    allowFavorites?: boolean;
    allowRatings?: boolean;
    allowComments?: boolean;
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
