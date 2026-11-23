import { usePublicSettings } from './usePublicSettings';
import { resolvePublicBaseUrl } from '../utils/url';

/**
 * The base for every link an admin hands to someone else: share links, QR
 * codes, client-access, short, slideshow, transfer and booking links (issue
 * 2630). It is the configured public site URL, so an admin panel opened on an
 * internal domain still copies the address guests can reach. Read from the
 * public settings because every admin needs it, with or without
 * `settings.view`. Until they load, or when no valid site URL is configured,
 * it is the browser origin, as before.
 *
 * The admin's own navigation ("View gallery" with the admin preview) keeps the
 * browser origin: the admin session cookie only exists there.
 */
export function usePublicBaseUrl(): string {
  const { data } = usePublicSettings();
  return resolvePublicBaseUrl(data?.public_site_url);
}
