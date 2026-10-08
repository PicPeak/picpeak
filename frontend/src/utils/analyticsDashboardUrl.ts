import { getApiBaseUrl } from './url';

/** HTTPS dashboards may execute only outside every PicPeak auth-cookie scope. */
export function analyticsDashboardUrl(raw?: string, cookieDomain?: string | null): string | null {
  // Undefined means the authenticated backend has not confirmed its scope.
  if (!raw || cookieDomain === undefined) return null;
  try {
    const url = new URL(raw);
    const hostname = (host: string) => host.toLowerCase().replace(/\.$/, '');
    const appHost = hostname(window.location.hostname);
    const apiHost = hostname(new URL(getApiBaseUrl(), window.location.origin).hostname);
    const dashboardHost = hostname(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password
      || dashboardHost === appHost || dashboardHost === apiHost) return null;
    if (cookieDomain !== null) {
      if (typeof cookieDomain !== 'string' || !/^\.?[A-Za-z0-9.-]+$/.test(cookieDomain)) return null;
      const domain = hostname(cookieDomain.replace(/^\./, ''));
      if (dashboardHost === domain || dashboardHost.endsWith('.' + domain)) return null;
    }
    return url.href;
  } catch { return null; }
}

/** No ordinary iframe fallback: redirects and child requests also need isolation. */
export function analyticsDashboardFrameProps(raw?: string, cookieDomain?: string | null) {
  if (typeof HTMLIFrameElement === 'undefined'
    || !('credentialless' in HTMLIFrameElement.prototype)) return null;
  const src = analyticsDashboardUrl(raw, cookieDomain);
  return src ? {
    credentialless: '', sandbox: 'allow-scripts allow-same-origin',
    referrerPolicy: 'no-referrer' as const, src,
  } : null;
}
