/**
 * The link in the "your download is ready" mail (issue 1733).
 *
 * The mail links to the gallery with `?download_job=<token>`, never to the
 * archive, so opening it goes through the normal gallery access first: the
 * password prompt and the expired page render in place and leave the query
 * string alone. Once the gallery itself is on screen it takes the token and
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
 * Read the token and drop it from the address bar, so a reload or a shared
 * link does not reopen the dialog. History state is kept: the router and the
 * lightbox store their own fields there.
 */
export function takeDownloadJobParam(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(DOWNLOAD_JOB_QUERY_PARAM)) return null;
  const token = readDownloadJobParam(url.search);
  url.searchParams.delete(DOWNLOAD_JOB_QUERY_PARAM);
  window.history.replaceState(window.history.state, '', url.toString());
  return token;
}
