import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loading } from '../../components/common';
import { api } from '../../config/api';
import { authService } from '../../services/auth.service';
import { clearGalleryToken } from '../../utils/galleryAuthStorage';
import { setFullLinkToken } from '../../utils/galleryFullLink';

/**
 * Entry point of the full link (issue 2356): keeps the token, ends a session
 * this browser may hold from the ordinary link (it would be reused and show
 * the selection only), and hands over to the gallery, whose login sends the
 * token along. The gallery password, when set, is asked for there.
 */
export function FullLinkPage() {
  const { slug = '', token = '' } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    (async () => {
      if (/^[0-9a-f]{64}$/.test(token)) setFullLinkToken(slug, token);
      // Only a session of THIS gallery is ended: the logout route falls back
      // to any gallery cookie, and another gallery's session must survive.
      const session = await api.get<{ valid?: boolean; type?: string; eventSlug?: string }>(
        '/auth/session', { params: { slug } },
      ).catch(() => null);
      if (session?.data?.valid && session.data.type === 'gallery' && session.data.eventSlug === slug) {
        await authService.galleryLogout(slug);
      }
      clearGalleryToken(slug);
      try {
        sessionStorage.removeItem(`gallery_event_${slug}`);
        sessionStorage.removeItem(`gallery_access_level_${slug}`);
      } catch {
        // nothing cached
      }
      if (live) navigate(`/gallery/${encodeURIComponent(slug)}`, { replace: true });
    })();
    return () => { live = false; };
  }, [slug, token, navigate]);

  return <Loading />;
}
