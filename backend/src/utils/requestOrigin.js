/**
 * Origin allow-listing shared by the CORS options and the multipart CSRF gate
 * in server.js. Kept apart from server.js so it can be unit-tested without
 * booting the app.
 */
function isAllowedOrigin(origin) {
  const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:3005',
    process.env.ADMIN_URL || 'http://localhost:3005'
  ];
  if (process.env.NODE_ENV === 'development') {
    allowedOrigins.push(
      'http://localhost:5173', // Vite dev server
      'http://localhost:3002', // Backend server
      'http://localhost:3001', // For API testing
      'http://localhost:3000'  // Direct backend access
    );
  }
  return allowedOrigins.indexOf(origin) !== -1;
}

// Origin check for multipart bodies (see the Content-Type gate below).
// Same-origin installs proxy /api through nginx and may not have FRONTEND_URL
// set, so an Origin matching the request Host is accepted alongside the CORS
// allowlist; Sec-Fetch-Site is authoritative when a browser sends it.
function multipartOriginAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'cross-site';
  const origin = req.headers.origin;
  if (!origin) return true;
  if (isAllowedOrigin(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}


module.exports = { isAllowedOrigin, multipartOriginAllowed };
