'use strict';

const dependencyHealth = require('../services/dependencyHealth');
const { isCapability } = require('../services/capabilities');
const logger = require('../utils/logger');

const OBSERVE_LOG_INTERVAL_MS = 60_000;
const RETRY_AFTER_SECONDS = 60;
const lastObserved = new Map();
const PAUSED_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>PicPeak</title>'
  + '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
  + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">'
  + '<p>This download is paused for a moment. Please go back and try again shortly.</p>'
  + '<p lang="de">Dieser Download ist kurz pausiert. Bitte gehen Sie zur&uuml;ck und versuchen Sie es gleich noch einmal.</p>'
  + '</body></html>';

/**
 * Refuses a request while a capability is unavailable.
 *
 * Mount it AFTER the route's auth and access checks, including any that run
 * inside the handler (there, call refuseCapability instead): this only ever
 * adds a refusal, and someone without access must not learn the state of the
 * server from it. The answer names the capability and no dependency, for the
 * same reason.
 *
 * In observe mode an automatic pause is logged, not applied. An admin's own
 * force-off always applies: they asked for it.
 */
function requireCapability(name) {
  if (!isCapability(name)) throw new Error(`Unknown capability: ${name}`);

  return function capabilityGuard(req, res, next) {
    if (!refuseCapability(req, res, name)) next();
  };
}

/**
 * The same decision for a route that can only tell partway through whether it
 * needs the capability. Answers the request and returns true when it refuses.
 */
function refuseCapability(req, res, name) {
  if (!capabilityPaused(name)) return false;
  sendCapabilityRefusal(req, res, name);
  return true;
}

/**
 * Whether `name` is refused right now. Logs an observe-mode pause, which it
 * does not apply. For a decision taken before the answer can be sent, such
 * as inside a multipart parser; answer with sendCapabilityRefusal.
 */
function capabilityPaused(name) {
  const decision = dependencyHealth.evaluate(name);
  if (decision.available) return false;
  if (decision.paused) return true;
  const now = Date.now();
  if (now - (lastObserved.get(name) || 0) >= OBSERVE_LOG_INTERVAL_MS) {
    lastObserved.set(name, now);
    logger.warn(`Would pause ${name} (observe mode)`, { blockedBy: decision.blockedBy });
  }
  return false;
}

function sendCapabilityRefusal(req, res, name) {
  // A refused upload's body is still arriving: without this the client sends
  // all of it before seeing the answer, as the sibling refusals note.
  if (req.method !== 'GET' && !req.readableEnded) res.set('Connection', 'close');
  res.set({ 'Retry-After': String(RETRY_AFTER_SECONDS), 'Cache-Control': 'no-store' });
  // A plain link, such as a transfer's Download all: the visitor navigated here,
  // so JSON would be the whole page. Fixed text only, nothing from the request.
  if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html') {
    res.status(503).type('html').send(PAUSED_PAGE);
    return;
  }
  res.status(503).json({
    error: 'This feature is temporarily unavailable',
    code: 'CAPABILITY_UNAVAILABLE',
    capability: name,
  });
}

module.exports = { requireCapability, refuseCapability, capabilityPaused, sendCapabilityRefusal };
