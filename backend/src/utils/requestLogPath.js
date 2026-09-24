/** Log the path without query values or bearer capabilities embedded in it. */
function requestLogPath(value) {
  const path = String(value || '/').split(/[?#]/, 1)[0];
  return path
    .replace(/(\/(?:signed|verify-token|show|download-jobs|invite|accept-invite|password-reset|unsubscribe)\/)[^/]+/gi, '$1[redacted]')
    .replace(/(\/api\/public\/[^/]+\/)[^/]+/gi, '$1[redacted]')
    .replace(/\b(?:[a-f0-9]{32,}|eyJ[A-Za-z0-9_.-]+)\b/gi, '[redacted]')
    // eslint-disable-next-line no-control-regex -- strip log injection control bytes
    .replace(/[\r\n\x00-\x1f]/g, '');
}
module.exports = { requestLogPath };
