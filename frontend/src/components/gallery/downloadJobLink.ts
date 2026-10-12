/**
 * The link in the "your download is ready" mail (issue 1733).
 *
 * The mail links to the gallery with `?download_job=<token>`, never to the
 * archive, so opening it goes through the normal gallery access first: the
 * password prompt and the expired page render in place and leave the query
 * string alone. Once the gallery itself is on screen it reads the token and
 * offers that job.
 *
 * The token is not a credential. The server checks gallery access and the
 * job's gallery and visibility scope on every request that names it.
 */
export const DOWNLOAD_JOB_QUERY_PARAM = 'download_job';

/** The job token from the address bar, or null when absent or not a token. */
export function readDownloadJobParam(search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
  const raw = new URLSearchParams(search).get(DOWNLOAD_JOB_QUERY_PARAM);
  return raw !== null && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

/**
 * Drop the token from the address bar once its dialog is closed, so a reload
 * or a copied link does not reopen it. Not done while reading: the gallery
 * view can mount more than once on the way in (and twice under StrictMode),
 * and a read that consumed the token left the second mount with nothing.
 * History state is kept: the router and the lightbox store their own fields
 * there.
 */
export function clearDownloadJobParam(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(DOWNLOAD_JOB_QUERY_PARAM)) return;
  url.searchParams.delete(DOWNLOAD_JOB_QUERY_PARAM);
  window.history.replaceState(window.history.state, '', url.toString());
}
