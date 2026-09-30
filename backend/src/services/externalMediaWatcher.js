/**
 * Folder watcher for reference-mode events (issue 1187).
 *
 * Managed uploads dropped into storage/events/active are imported by
 * fileWatcher.js without anyone touching the admin UI. External media had no
 * equivalent: a reference event's NAS folder keeps growing, and every new
 * batch waits for someone to open the event and press Import. This service
 * runs that same import pass — literally the same function the button calls —
 * whenever a watched folder changes, and again on a timer.
 *
 * Shape, and why:
 *
 *   - Per-event opt-in (`events.external_watch`, migration 208), not a global
 *     switch. Each watched tree is a set of inotify handles or, on a mount
 *     that does not deliver events, a polling stat of every file in it. An
 *     install with hundreds of reference events should only pay that for the
 *     ones still receiving files.
 *
 *   - Change events trigger a debounced full pass over the folder, not a
 *     per-file insert. The import already skips rows it has, so a full pass
 *     costs one directory walk plus work for the new files — and it keeps
 *     exactly one code path for external ingest, with the dedupe, the type
 *     inference, the thumbnail and the face enqueue all in one place.
 *
 *   - A periodic sweep is the fallback, not an optimisation. NFS and SMB
 *     mounts routinely deliver no inotify events at all for writes made from
 *     another host, which for a NAS is the normal case. Without the sweep a
 *     watcher on such a mount would look configured and silently do nothing.
 *     EXTERNAL_MEDIA_WATCH_POLLING=true switches chokidar to stat-polling for
 *     installs that want change-driven imports on those mounts anyway.
 *
 *   - Deletions are ignored, deliberately. The manual import only ever adds.
 *     A file vanishing from the NAS is at least as likely to be a folder
 *     being reorganised, a mount dropping out, or a copy in progress as it is
 *     an intentional removal — and acting on it would delete a guest-visible
 *     photo. Rows whose file is gone stay, exactly as they do today.
 *
 *   - Every replica watches. Which one actually imports is settled by the
 *     per-event claim inside importExternalFolder; the others get
 *     ImportInProgressError and stand down. That is what makes the same code
 *     correct for the AIO container, a two-container install, and a
 *     multi-replica deploy behind a load balancer.
 *
 *   - Not gated on STORAGE_BACKEND. Unlike the managed watcher,
 *     EXTERNAL_MEDIA_ROOT is always a local filesystem path — reference
 *     galleries are not migrated to S3 — so an S3 install can watch too.
 *
 * Reconciliation runs on a timer against the events table rather than being
 * signalled by the toggle endpoint: the endpoint may execute on a different
 * replica than the one holding the watcher, and a minute of latency on a
 * checkbox is a better trade than cross-process signalling.
 */

const path = require('path');
const fs = require('fs').promises;
const chokidar = require('chokidar');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const logger = require('../utils/logger');
const { resolveExternalPath } = require('./externalMediaService');
const {
  importExternalFolder,
  ImportInProgressError,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} = require('./externalImportService');

const envInt = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

// Kill switch. Default on: the feature is already opt-in per event, so an
// install with no watched events runs nothing but the reconcile query.
const ENABLED = (process.env.EXTERNAL_MEDIA_WATCH || 'true').toLowerCase() !== 'false';
// Stat-polling instead of inotify, for mounts that do not deliver events.
const USE_POLLING = (process.env.EXTERNAL_MEDIA_WATCH_POLLING || 'false').toLowerCase() === 'true';
const POLL_INTERVAL_MS = envInt('EXTERNAL_MEDIA_WATCH_POLL_INTERVAL_MS', 5000);
// How long a file must stop growing before it counts as written. Generous:
// a NAS copy of a 40 MB raw export can stall for seconds mid-file.
const STABILITY_MS = envInt('EXTERNAL_MEDIA_WATCH_STABILITY_MS', 5000);
// Quiet period after the last change before the pass runs, so a batch copy
// of 300 files becomes one import rather than 300.
const DEBOUNCE_MS = envInt('EXTERNAL_MEDIA_WATCH_DEBOUNCE_MS', 10000);
// Timer-driven pass over every watched event. 0 disables the sweep.
const SWEEP_INTERVAL_MS = envInt('EXTERNAL_MEDIA_WATCH_SWEEP_INTERVAL_MS', 15 * 60 * 1000);
// How often the set of watched events is re-read from the database.
const RECONCILE_INTERVAL_MS = envInt('EXTERNAL_MEDIA_WATCH_RECONCILE_INTERVAL_MS', 60 * 1000);

const ACTOR = { type: 'system', name: 'external-media-watcher' };

// eventId -> { externalPath, watcher, timer }
const watched = new Map();
// Folders reported missing, so the reconcile loop logs each once rather than
// once a minute until the mount comes back.
const missingLogged = new Set();
let reconcileTimer = null;
let sweepTimer = null;
let started = false;

/**
 * Events that asked to be watched and can be: reference mode, a folder set,
 * live, not archived. Exported for the test.
 */
async function listWatchedEvents() {
  return db('events')
    .where({ source_mode: 'reference', external_watch: formatBoolean(true) })
    .whereNotNull('external_path')
    .where('is_active', formatBoolean(true))
    .where(function () {
      this.where('is_archived', formatBoolean(false)).orWhereNull('is_archived');
    })
    .select('id', 'slug', 'external_path');
}

// Which files are worth a pass. Every video extension counts here, allowed or
// not: the pass itself reads the setting and takes only what it may
// (importableExtensions), so a clip on an install without video costs one walk
// that imports nothing.
const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
const isMedia = (filePath) => MEDIA_EXTENSIONS.includes(path.extname(filePath).toLowerCase());

/**
 * One import pass for an event. The event is re-read first: the folder may
 * have moved or the toggle may have been cleared since the change that
 * scheduled this, and the pass must follow the row, not the scheduler's memory.
 *
 * Returns the import result, or null when nothing ran.
 */
async function runImport(eventId, reason) {
  const event = await db('events').where('id', eventId).first();
  // The same eligibility listWatchedEvents() applies, re-checked at run time:
  // reconcile only looks once a minute, and an event archived or deactivated
  // inside that window must not gain photos from a pass scheduled before.
  if (
    !event || !event.external_watch || event.source_mode !== 'reference' || !event.external_path
    || !event.is_active || event.is_archived
  ) {
    return null;
  }
  try {
    const result = await importExternalFolder({
      eventId,
      externalPath: event.external_path,
      recursive: true,
      actor: ACTOR,
      // Automatic pass: follow the row rather than writing it, keep out what
      // an admin deleted, leave files still being copied for the next pass
      // (see externalImportService).
      automatic: true,
      settleMs: STABILITY_MS,
    });
    if (result.imported > 0 || result.deferred > 0) {
      logger.info(`[externalMediaWatcher] event ${eventId} (${event.slug}): imported ${result.imported}, skipped ${result.skipped}, deferred ${result.deferred}, excluded ${result.excluded} (${reason})`);
    } else {
      logger.debug(`[externalMediaWatcher] event ${eventId}: nothing new (${reason})`);
    }
    // A deferred file gets no second 'add' event (ignoreInitial, and the copy
    // that made it unsettled already fired its one), and the sweep may be
    // disabled — so the pass re-arms itself until the folder is quiet.
    if (result.deferred > 0) scheduleImport(eventId);
    return result;
  } catch (err) {
    if (err instanceof ImportInProgressError) {
      // Someone else — the Import button, or this watcher on another replica
      // — is already walking this folder. A change-triggered pass re-arms so
      // files that landed during that run are not left for the sweep; the
      // sweep itself just tries again next tick.
      logger.debug(`[externalMediaWatcher] event ${eventId}: import already running, ${reason === 'change' ? 're-arming' : 'skipping'}`);
      if (reason === 'change') scheduleImport(eventId);
      return null;
    }
    logger.error(`[externalMediaWatcher] import failed for event ${eventId}: ${err.message}`);
    return null;
  }
}

/**
 * Debounced trigger. Each new change pushes the run back, so a batch copy
 * settles into a single pass once the folder has been quiet for DEBOUNCE_MS.
 */
function scheduleImport(eventId) {
  const entry = watched.get(eventId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    runImport(eventId, 'change').catch((err) => {
      logger.error(`[externalMediaWatcher] scheduled import failed for event ${eventId}: ${err.message}`);
    });
  }, DEBOUNCE_MS);
  entry.timer.unref?.();
}

/**
 * Start a watcher for one event. Returns true when it is now watched, false
 * when it could not be (bad path, folder not there yet).
 */
async function startWatching(event) {
  let absPath;
  try {
    absPath = resolveExternalPath({ external_path: event.external_path }, '');
  } catch (err) {
    // A path outside EXTERNAL_MEDIA_ROOT cannot be watched, and should not
    // have been saved. Log and leave it; nothing to clean up.
    logger.warn(`[externalMediaWatcher] event ${event.id}: refusing to watch '${event.external_path}': ${err.message}`);
    return false;
  }

  try {
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (err) {
    // The mount is not there (yet). Reconcile retries every minute, and the
    // sweep will not run for an event that is not in `watched` either — a
    // folder that cannot be listed has nothing to import.
    if (!missingLogged.has(event.id)) {
      missingLogged.add(event.id);
      logger.warn(`[externalMediaWatcher] event ${event.id} (${event.slug}): folder '${event.external_path}' is not readable (${err.message}); will retry`);
    }
    return false;
  }
  missingLogged.delete(event.id);

  const watcher = chokidar.watch(absPath, {
    // The sweep and the first reconcile cover what is already there; firing
    // 'add' for every existing file on boot would schedule an import of a
    // folder that was just imported.
    ignoreInitial: true,
    persistent: true,
    ignored: (p) => path.basename(p).startsWith('.'),
    usePolling: USE_POLLING,
    interval: POLL_INTERVAL_MS,
    binaryInterval: POLL_INTERVAL_MS,
    awaitWriteFinish: {
      stabilityThreshold: STABILITY_MS,
      pollInterval: Math.min(1000, STABILITY_MS),
    },
  });

  const entry = { externalPath: event.external_path, watcher, timer: null };
  watched.set(event.id, entry);

  watcher
    .on('add', (filePath) => {
      if (isMedia(filePath)) scheduleImport(event.id);
    })
    .on('unlink', (filePath) => {
      // Deliberately not acted on — see the header comment.
      if (isMedia(filePath)) logger.debug(`[externalMediaWatcher] event ${event.id}: file removed, row kept: ${path.relative(absPath, filePath)}`);
    })
    .on('error', (err) => {
      logger.warn(`[externalMediaWatcher] event ${event.id}: watcher error: ${err.message}`);
    });

  logger.info(`[externalMediaWatcher] watching event ${event.id} (${event.slug}) at '${event.external_path}'${USE_POLLING ? ' (polling)' : ''}`);
  return true;
}

async function stopWatching(eventId) {
  const entry = watched.get(eventId);
  if (!entry) return;
  watched.delete(eventId);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    await entry.watcher.close();
  } catch (err) {
    logger.debug(`[externalMediaWatcher] close failed for event ${eventId}: ${err.message}`);
  }
  logger.info(`[externalMediaWatcher] stopped watching event ${eventId}`);
}

/**
 * Bring the set of live watchers in line with the events table: start for
 * events that opted in since the last pass, restart the ones whose folder
 * moved, stop the ones that opted out, archived, or went inactive.
 *
 * A watcher that just started gets one pass straight away. chokidar is told
 * to ignore what is already in the folder, so without this an admin ticking
 * the box — or a mount coming back after an outage, or a fresh replica
 * booting — would see nothing happen until the next sweep. The pass skips
 * rows the event already has, so on a folder that was imported by hand it
 * costs one directory walk.
 */
async function reconcile() {
  let events;
  try {
    events = await listWatchedEvents();
  } catch (err) {
    logger.warn(`[externalMediaWatcher] could not list watched events: ${err.message}`);
    return;
  }

  const wanted = new Map(events.map((e) => [e.id, e]));

  for (const eventId of [...watched.keys()]) {
    const next = wanted.get(eventId);
    if (!next || next.external_path !== watched.get(eventId).externalPath) {
      await stopWatching(eventId);
    }
  }

  const fresh = [];
  for (const event of wanted.values()) {
    if (!watched.has(event.id) && await startWatching(event)) {
      fresh.push(event.id);
    }
  }

  for (const eventId of fresh) {
    await runImport(eventId, 'start');
  }
}

/**
 * Timer-driven pass over every watched event, one at a time. Sequential on
 * purpose: each pass reads and decodes new files off the mount, and running
 * them in parallel would only make a slow NAS slower.
 */
async function sweep() {
  for (const eventId of [...watched.keys()]) {
    await runImport(eventId, 'sweep');
  }
}

function startExternalMediaWatcher() {
  if (!ENABLED) {
    logger.info('[externalMediaWatcher] disabled via EXTERNAL_MEDIA_WATCH=false');
    return null;
  }
  if (started) return null;
  started = true;

  reconcile().catch((err) => logger.warn(`[externalMediaWatcher] initial reconcile failed: ${err.message}`));

  reconcileTimer = setInterval(() => {
    reconcile().catch((err) => logger.warn(`[externalMediaWatcher] reconcile failed: ${err.message}`));
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  if (SWEEP_INTERVAL_MS > 0) {
    sweepTimer = setInterval(() => {
      sweep().catch((err) => logger.warn(`[externalMediaWatcher] sweep failed: ${err.message}`));
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  logger.info(`[externalMediaWatcher] started (sweep every ${SWEEP_INTERVAL_MS > 0 ? `${Math.round(SWEEP_INTERVAL_MS / 60000)} min` : 'never'}, debounce ${DEBOUNCE_MS} ms${USE_POLLING ? ', polling' : ''})`);
  return { reconcile, sweep };
}

/**
 * Tear everything down. For tests and for a clean shutdown; the process exits
 * fine without it because every timer is unref'd.
 */
async function stopExternalMediaWatcher() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  reconcileTimer = null;
  sweepTimer = null;
  for (const eventId of [...watched.keys()]) {
    await stopWatching(eventId);
  }
  missingLogged.clear();
  started = false;
}

module.exports = {
  startExternalMediaWatcher,
  stopExternalMediaWatcher,
  // Exposed for the test suite.
  reconcile,
  sweep,
  runImport,
  listWatchedEvents,
  watchedEventIds: () => [...watched.keys()],
};
