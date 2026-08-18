/**
 * HTTP client for the picpeak-ml sidecar (#1074).
 *
 * The important behaviour here is the error taxonomy, because the queue
 * treats the two classes completely differently:
 *
 *   SidecarUnavailableError — the sidecar is down, unreachable, timing out,
 *     or returned 5xx. The photo goes BACK to 'pending' and is retried later.
 *     Turning the container off for a week must not require a manual re-scan.
 *
 *   Everything else (4xx) — this image is a lost cause. The photo is marked
 *     'failed' and never retried, because retrying an undecodable file
 *     forever is just a busy loop.
 *
 * Log volume matters too: an hour of downtime at a 1s poll is 3,600 identical
 * warnings. Unavailability is logged at most once per LOG_INTERVAL_MS.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getSidecarUrl, getSidecarToken } = require('./faceSettings');

const REQUEST_TIMEOUT_MS = parseInt(process.env.FACE_ML_TIMEOUT_MS || '30000', 10);
const LOG_INTERVAL_MS = 5 * 60 * 1000;

let lastUnavailableLogAt = 0;

class SidecarUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SidecarUnavailableError';
  }
}

class SidecarRejectedError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SidecarRejectedError';
    this.status = status;
  }
}

function logUnavailable(message) {
  const now = Date.now();
  if (now - lastUnavailableLogAt < LOG_INTERVAL_MS) return;
  lastUnavailableLogAt = now;
  logger.warn(
    `faceClient: ML sidecar unavailable (${message}). Photos stay queued and will ` +
    'be retried; no action needed unless this persists. Further identical warnings ' +
    'are suppressed for 5 minutes.'
  );
}

function authHeaders() {
  const token = getSidecarToken();
  return token ? { 'X-Face-ML-Token': token } : {};
}

/**
 * Translate an axios failure into our two-class taxonomy.
 */
function classify(err) {
  const status = err.response?.status;

  if (status && status >= 400 && status < 500) {
    // 401 is a configuration error, not a bad image — but it is also not
    // something retrying fixes, so it surfaces loudly and stops the photo.
    if (status === 401) {
      logger.error(
        'faceClient: sidecar rejected our token (401). FACE_ML_TOKEN must match ' +
        'on both the backend and the picpeak-ml container.'
      );
    }
    return new SidecarRejectedError(
      err.response?.data?.detail || `Sidecar rejected the request (${status})`,
      status
    );
  }

  logUnavailable(err.code || err.message || `HTTP ${status}`);
  return new SidecarUnavailableError(err.message || 'Sidecar unreachable');
}

/**
 * Detect faces in an image. `buffer` is the preview rendition's bytes.
 * Returns the sidecar's `{ model_version, faces: [...] }`.
 */
async function detectFaces(buffer, filename = 'photo.jpg') {
  const form = new FormData();
  // Node 18+ ships FormData/Blob globally, so no multipart dependency is
  // needed for the one endpoint that uploads anything.
  form.append('image', new Blob([buffer]), filename);

  try {
    const response = await axios.post(`${getSidecarUrl()}/faces`, form, {
      headers: authHeaders(),
      timeout: REQUEST_TIMEOUT_MS,
      // A 45MP preview is ~2MB; the cap is generous but not unbounded.
      maxBodyLength: 64 * 1024 * 1024,
      maxContentLength: 64 * 1024 * 1024,
    });
    return response.data;
  } catch (err) {
    throw classify(err);
  }
}

/**
 * Sidecar identity + liveness, for the admin connection test.
 * Returns { ok: true, info } or { ok: false, error } — never throws, because
 * the caller is a UI button and a stack trace helps nobody there.
 */
async function checkHealth() {
  try {
    const { data } = await axios.get(`${getSidecarUrl()}/info`, {
      headers: authHeaders(),
      timeout: 5000,
    });
    return { ok: true, info: data };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      return { ok: false, error: 'Sidecar rejected the token (check FACE_ML_TOKEN on both containers)' };
    }
    return { ok: false, error: err.message || 'Sidecar unreachable' };
  }
}

module.exports = {
  detectFaces,
  checkHealth,
  SidecarUnavailableError,
  SidecarRejectedError,
};
