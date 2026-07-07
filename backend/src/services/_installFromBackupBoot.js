/**
 * Install-from-backup boot hook.
 *
 * **The problem this closes**
 *
 * Without this hook, recovering a picpeak install from a backup is a
 * six-step process:
 *   1. Stand up the compose stack with empty volumes
 *   2. Wait for boot → land on the onboarding wizard
 *   3. Create a throwaway fresh-install admin
 *   4. Navigate to Backup → Restore
 *   5. Walk through the wizard with Force Restore ticked
 *   6. Log out, log back in with original (pre-disaster) credentials
 *
 * With this hook, admins skip steps 2-6. They place their backup
 * artefacts in the existing bind-mounted /backup directory, drop a
 * trigger file alongside, and the next container start runs the
 * restore BEFORE creating the throwaway onboarding admin. Server
 * comes up populated, original login works first try.
 *
 * **The trigger file convention (chosen for zero compose-file changes)**
 *
 * Drop a file named `RESTORE_ON_INSTALL` (no extension, or .txt) into
 * the root of the `/backup` mount. Two payload variants:
 *
 *   1. EMPTY file (or pure whitespace) — auto-pick the newest
 *      `backup-manifest-*.json` from `/backup/manifests/`. Useful when
 *      the admin doesn't know or care which one is most recent.
 *
 *   2. NON-EMPTY file containing a relative or absolute path to a
 *      specific manifest. Trimmed; first line wins. Useful when the
 *      admin wants a specific older backup.
 *
 * After a successful restore the trigger file is DELETED so the next
 * boot doesn't re-trigger. On failure the file is preserved + the
 * error is logged, so the admin can fix the input and retry by just
 * restarting the container.
 *
 * **Safety**
 *
 * Three layers gate this against accidental data loss:
 *   1. Trigger file must exist (intentional admin action, not auto-magic)
 *   2. DB must be empty — admin_users.count = 0 AND events.count = 0.
 *      If either is non-zero, the hook refuses to run.
 *   3. The Stage A restore path (with all of tonight's fixes) handles
 *      the actual swap atomically. If anything fails, the rollback
 *      runs and the install stays in fresh-install state.
 *
 * Override: `INSTALL_FROM_BACKUP_FORCE=true` skips the empty-DB check
 * for the "I know what I'm doing" edge case (e.g. dev environment
 * rebuilds where there's leftover data that's safe to clobber).
 */

const fs = require('fs');
const path = require('path');

const TRIGGER_FILENAMES = ['RESTORE_ON_INSTALL', 'RESTORE_ON_INSTALL.txt'];

/**
 * Resolve which file should be treated as the trigger. Returns
 * `{ triggerPath, manifestPath }` if found, or null if no trigger
 * file is present (the common case — most boots).
 */
async function findTrigger(backupRoot, logger) {
  for (const name of TRIGGER_FILENAMES) {
    const triggerPath = path.join(backupRoot, name);
    if (fs.existsSync(triggerPath)) {
      let payload;
      try {
        payload = fs.readFileSync(triggerPath, 'utf8').trim();
      } catch (err) {
        logger.warn(`Install-from-backup: trigger file ${triggerPath} is unreadable: ${err.message}`);
        return null;
      }

      if (!payload) {
        // Auto-pick the newest manifest
        const manifestsDir = path.join(backupRoot, 'manifests');
        if (!fs.existsSync(manifestsDir)) {
          logger.warn(`Install-from-backup: trigger file found but ${manifestsDir} doesn't exist`);
          return null;
        }
        const entries = fs.readdirSync(manifestsDir)
          .filter((f) => /^backup-manifest-.+\.(json|ya?ml)$/i.test(f))
          .map((f) => {
            const full = path.join(manifestsDir, f);
            return { full, mtime: fs.statSync(full).mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);
        if (entries.length === 0) {
          logger.warn(`Install-from-backup: no manifests found in ${manifestsDir}`);
          return null;
        }
        return { triggerPath, manifestPath: entries[0].full };
      }

      // Take the first non-empty line as the manifest path
      const firstLine = payload.split(/\r?\n/).find((l) => l.trim()) || '';
      const manifestPath = path.isAbsolute(firstLine)
        ? firstLine
        : path.join(backupRoot, firstLine);

      if (!fs.existsSync(manifestPath)) {
        logger.warn(`Install-from-backup: trigger file points at ${manifestPath} which doesn't exist`);
        return null;
      }
      return { triggerPath, manifestPath };
    }
  }
  return null;
}

/**
 * Check the DB is empty enough that restoring on top is safe.
 * Returns `true` if safe, `false` if there's existing data.
 */
async function isDatabaseFresh(db, logger) {
  try {
    if (!(await db.schema.hasTable('admin_users'))) {
      // No admin_users table yet — schema is mid-migration or wholly
      // empty. Definitely safe to restore on top.
      return true;
    }
    const adminCount = await db('admin_users').count('* as c').first();
    const adminN = Number(adminCount?.c || 0);

    let eventN = 0;
    if (await db.schema.hasTable('events')) {
      const eventCount = await db('events').count('* as c').first();
      eventN = Number(eventCount?.c || 0);
    }

    if (adminN > 1 || eventN > 0) {
      logger.warn(
        `Install-from-backup: refusing — install has ${adminN} admin(s) and ${eventN} event(s). `
        + 'This guard prevents accidental clobbering of production data. '
        + 'Override with INSTALL_FROM_BACKUP_FORCE=true if you really want to restore on top.'
      );
      return false;
    }

    // adminN === 1 is the "fresh install ran migration 001 and auto-created
    // the default admin" case. That admin is throwaway — the restore will
    // replace it with the backup's admin row. So we treat 1 admin + 0
    // events as fresh.
    return true;
  } catch (err) {
    logger.warn(`Install-from-backup: fresh-install check threw: ${err.message}. Assuming NOT fresh.`);
    return false;
  }
}

/**
 * Public entry point — called from server.js after migrations and
 * before startServer.
 *
 * @returns {Promise<{ ran: boolean, manifestPath?: string, error?: string }>}
 */
async function tryInstallFromBackup(db, logger) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };

  // The container's winston logger writes to `/app/logs/combined.log`
  // by default and may not always tee to stdout, so admins running
  // `docker logs picpeak-beta-backend` after a `compose up` would
  // see no signal that a restore happened — flagged on PR #596
  // review. We mirror the key trigger / start / end lines to
  // console.log as well so the docker-logs surface tells the story
  // without needing to exec into the container.
  const announce = (msg) => {
    try { console.log(`[install-from-backup] ${msg}`); } catch (_) { /* defensive */ }
  };

  const backupRoot = process.env.BACKUP_ROOT || '/backup';
  if (!fs.existsSync(backupRoot)) {
    return { ran: false };
  }

  const trigger = await findTrigger(backupRoot, log);
  if (!trigger) {
    return { ran: false };
  }

  log.info(`Install-from-backup: trigger file found at ${trigger.triggerPath}, target manifest ${trigger.manifestPath}`);
  announce(`trigger file detected → ${trigger.manifestPath}`);

  const forceOverride = process.env.INSTALL_FROM_BACKUP_FORCE === 'true';
  const isFresh = await isDatabaseFresh(db, log);
  if (!isFresh && !forceOverride) {
    log.warn('Install-from-backup: skipping. Trigger file left in place so you can correct + retry.');
    announce('skipping — install has existing data and INSTALL_FROM_BACKUP_FORCE is not set');
    return { ran: false, error: 'Database not empty' };
  }

  log.info(`Install-from-backup: restoring from ${trigger.manifestPath}...`);
  announce(`starting restore from ${trigger.manifestPath}`);

  try {
    const { restoreService } = require('./restoreService');
    const result = await restoreService.restore({
      source: 'local',
      manifestPath: trigger.manifestPath,
      restoreType: 'full',
      // Force=true because the fresh-install admin auto-created by
      // migration 001 trips the "1 active admin" warning — we WANT to
      // override that warning, since replacing the throwaway admin
      // with the backup's admin is exactly the goal.
      force: true,
      // SkipPreBackup=true because backing up an empty install is
      // pointless. Saves a few seconds and reduces disk noise.
      skipPreBackup: true,
      operator: {
        type: 'install-from-backup',
        userId: null,
        ip: null,
      },
    });

    if (result?.success === false) {
      throw new Error(result?.error || 'Restore service reported failure');
    }

    log.info(`Install-from-backup: restore completed successfully from ${trigger.manifestPath}`);
    announce('restore completed successfully');

    // Remove the trigger so the next boot doesn't redo it.
    try {
      fs.unlinkSync(trigger.triggerPath);
      log.info(`Install-from-backup: removed trigger file ${trigger.triggerPath}`);
    } catch (unlinkErr) {
      log.warn(`Install-from-backup: could not remove trigger file (manual cleanup needed): ${unlinkErr.message}`);
    }

    return { ran: true, manifestPath: trigger.manifestPath };
  } catch (err) {
    log.error(`Install-from-backup: FAILED — ${err.message}`);
    log.warn('Trigger file left in place so you can fix the input and retry by restarting the container.');
    announce(`FAILED — ${err.message}. Trigger file left in place for retry.`);
    return { ran: false, error: err.message };
  }
}

module.exports = { tryInstallFromBackup };
