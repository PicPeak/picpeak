import React from 'react';
import { ClipboardList, Shield, Upload } from 'lucide-react';
import { Button } from '../../common';
import { BackToAccountLink } from '../BackToAccountLink';
import { GalleryEmptyMessage, LikedOnlyEmptyMessage } from '../GalleryEmptyMessage';
import { useFullPageLabels } from './fullPageNav';

/**
 * The copyable filename list (issue 1733, A3d) where a full-page layout has
 * no photos to show. Event-wide like the nav button: a filter that leaves
 * nothing on screen must not take the favourites' list with it.
 */
export const EmptyCopyFilenames: React.FC<{ onCopyFilenames?: () => void; count: number }> = ({ onCopyFilenames, count }) => {
  const labels = useFullPageLabels({ copyFilenamesCount: count });
  if (!onCopyFilenames || count === 0) return null;
  return (
    <div className="mt-4 flex justify-center">
      <Button
        variant="outline"
        size="sm"
        leftIcon={<ClipboardList className="w-4 h-4" />}
        onClick={onCopyFilenames}
        className="text-xs sm:text-sm"
      >
        {labels.copyFilenames}
      </Button>
    </div>
  );
};

interface FullPageEmptyStateProps {
  /** The feature toolbox, so a filter that left nothing can be cleared from here (issue 2355). */
  toolbar?: React.ReactNode;
  /** The layout's own class for the toolbox row. */
  toolbarClassName: string;
  showBackToAccount?: boolean;
  onManageGallery?: () => void;
  clientModeBusy?: boolean;
  isClient?: boolean;
  likedOnly?: boolean;
  onToggleLikedOnly?: () => void;
  emptyIsFiltered?: boolean;
  onUploadClick?: () => void;
  onCopyFilenames?: () => void;
  copyFilenamesCount?: number;
}

/**
 * A full-page layout with nothing in scope: no hero and no nav, so the ways
 * out the nav would offer sit here.
 */
export const FullPageEmptyState: React.FC<FullPageEmptyStateProps> = ({
  toolbar,
  toolbarClassName,
  showBackToAccount = false,
  onManageGallery,
  clientModeBusy,
  isClient = false,
  likedOnly = false,
  onToggleLikedOnly,
  emptyIsFiltered = false,
  onUploadClick,
  onCopyFilenames,
  copyFilenamesCount = 0,
}) => {
  const labels = useFullPageLabels({ isClient });
  return (
    <div className="text-center py-12">
      {toolbar && <div className={toolbarClassName}>{toolbar}</div>}
      {/* No nav in this branch, so the way back to the portal sits here. */}
      {showBackToAccount && (
        <div className="mb-4 flex justify-center">
          <BackToAccountLink alwaysLabelled className="inline-flex items-center gap-1.5 text-sm text-muted-theme hover:text-theme" />
        </div>
      )}
      {onManageGallery && <Button variant="outline" className="mb-4" onClick={onManageGallery} disabled={clientModeBusy}
        leftIcon={<Shield className="w-4 h-4" />}>
        {labels.manage}
      </Button>}
      {likedOnly
        ? <LikedOnlyEmptyMessage onShowAll={onToggleLikedOnly} />
        : <GalleryEmptyMessage filtered={emptyIsFiltered} />}
      {/* No nav in this branch, and an upload-only gallery starts empty:
          the guest still needs a way to add the first photos. */}
      {onUploadClick && (
        <Button
          variant="primary"
          className="mt-4"
          leftIcon={<Upload className="w-4 h-4" />}
          onClick={onUploadClick}
          data-gallery-focus="upload"
        >
          {labels.upload}
        </Button>
      )}
      <EmptyCopyFilenames onCopyFilenames={onCopyFilenames} count={copyFilenamesCount} />
    </div>
  );
};
