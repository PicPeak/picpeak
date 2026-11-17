import { useCallback } from 'react';
import { usePermissions } from '../contexts/PermissionsContext';
import { buildAdminPreviewUrl, buildShareLinkUrl } from '../utils/url';

/**
 * The URL an admin's "View gallery" button opens.
 *
 * With the admin preview (#868) the gallery lets the admin in through the
 * admin cookie, but only with events.view + photos.view
 * (galleryAccessService, the admin grant). An admin without them would get a
 * "forbidden" tab, so they get the plain share link instead and see the
 * gallery the way a guest does: a public gallery opens, a protected one asks
 * for the password. While permissions are still loading this is the plain
 * link too.
 */
export function useViewGalleryUrl(): (link: string | null | undefined) => string {
  const { hasPermission } = usePermissions();
  const canPreview = hasPermission('events.view') && hasPermission('photos.view');
  return useCallback(
    (link) => (canPreview ? buildAdminPreviewUrl(link) : buildShareLinkUrl(link)),
    [canPreview],
  );
}
