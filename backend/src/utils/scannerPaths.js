/**
 * Paths only a vulnerability scanner asks a PicPeak instance for: server-side
 * script extensions PicPeak never serves, and the install directories of other
 * products. They must answer 404, not the SPA shell — see the history fallback
 * in server.js.
 *
 * Deliberately narrow. Bare words are out (an operator may publish a CMS page
 * called /vendor), and so is anything a download could be named (.zip, .sql).
 *
 * Keep in sync with the two `location ~*` blocks at the top of
 * frontend/nginx.conf; __tests__/utils/scannerPaths.test.js pins that.
 */
const SCANNER_PROBE_RE = /\.(?:php\d?|phtml|aspx?|jspx?|cgi)$|^\/(?:wp-admin|wp-content|wp-includes|phpmyadmin|cgi-bin)(?:\/|$)/i;

/**
 * @param {string} path  req.path — no query string.
 * @returns {boolean}
 */
function isScannerProbePath(path) {
  return SCANNER_PROBE_RE.test(path || '');
}

module.exports = { isScannerProbePath };
