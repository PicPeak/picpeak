/*
 * Pre-React theme bootstrap (#358).
 *
 * Loaded as an external script (rather than inline) so a strict CSP
 * with no 'unsafe-inline' / hash / nonce — like the one Caddy puts in
 * front of demo.picpeak.app — does not block it (#564).
 *
 * Reads the per-gallery cached background written by ThemeContext on
 * the previous visit and applies it before React mounts, so revisits
 * land on the right colour from the first frame. The OS-preference
 * default is already handled by the @media CSS in index.html for
 * first-visit / cache-miss callers.
 *
 * Placed in /public so vite copies it to /bootstrap.js at build time
 * (same pipeline as /favicon-32x32.png). Kept in <head> without
 * defer/async so it runs before <body> paints.
 */
(function () {
  try {
    var m = location.pathname.match(/\/gallery\/([^\/?#]+)/);
    var bg = null;
    if (m && m[1]) {
      bg = localStorage.getItem('gallery-theme-bg-' + decodeURIComponent(m[1]));
    }
    if (bg) {
      var root = document.documentElement;
      root.style.backgroundColor = bg;
      document.body && (document.body.style.backgroundColor = bg);
      root.style.setProperty('--color-background', bg);
    }
  } catch (e) { /* never block render on a cache miss */ }
})();
