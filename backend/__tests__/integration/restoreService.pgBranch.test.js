/**
 * Pins the fix for the PR #596 review blocker.
 *
 * **The bug**
 *
 *   `preservedMeta` was declared with `let` INSIDE the PostgreSQL
 *   `else` branch of `performDatabaseRestore`, then read AFTER the
 *   `else` block closed at the shared replay site (~L1030). On every
 *   real PG restore:
 *
 *     ReferenceError: preservedMeta is not defined
 *
 *   would fire — psql had already completed the data restore, but
 *   the operator-meta replay never ran, the trigger file was left
 *   in place by `_installFromBackupBoot.js` because the restore
 *   "failed", and `combined.log` got a loud FAILED line even though
 *   the data was back. Caught on PR #596 review by the maintainer.
 *
 * **Why CI missed it**
 *
 *   The integration tests around `performFullRestore` only exercise
 *   the SQLite branch via `this.dbType === 'sqlite'`. The PG branch
 *   (~L827-984) requires a real PG connection + real `psql` binary,
 *   neither of which are in the test environment. So the scope leak
 *   sat untested until the maintainer ran a real DR cycle.
 *
 * **What this test does**
 *
 *   Reads the source of `restoreService.js` and asserts the scope
 *   contract: the `preservedMeta` declaration sits ABOVE the
 *   SQLite/PG branch split, so the replay block at the bottom of the
 *   try{} can read it on either branch.
 *
 *   Source-inspection is uglier than a runtime test but it has two
 *   advantages here: (a) it doesn't require a real PG cluster + psql
 *   binary in CI, (b) it pins the EXACT contract — "the declaration
 *   must be visible to the replay block" — which is the property
 *   that broke, more directly than a runtime test would.
 *
 *   The follow-up "real-PG integration test in CI" (separate task)
 *   would replace this with an end-to-end exercise, at which point
 *   this can be deleted.
 */

const fs = require('fs');
const path = require('path');

describe('restoreService — PG branch scope contract (PR #596 review)', () => {
  let src;
  let lines;

  beforeAll(() => {
    src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'restoreService.js'),
      'utf8',
    );
    lines = src.split(/\r?\n/);
  });

  /** Return the 1-based line number of the FIRST line matching `re`. */
  function findFirst(re) {
    const idx = lines.findIndex((l) => re.test(l));
    return idx >= 0 ? idx + 1 : -1;
  }

  /** Return the 1-based line number of the LAST line matching `re`. */
  function findLast(re) {
    let last = -1;
    lines.forEach((l, i) => { if (re.test(l)) last = i + 1; });
    return last;
  }

  it('preservedMetaSnapshot lives on `this` and is initialised in the constructor', () => {
    // PR #596 round 3 moved the snapshot from a block-scoped local to
    // an instance variable so the replay can happen in `restore()`
    // AFTER post-restore verification — preventing the replay row
    // from inflating the row-count check.
    //
    // Contract:
    //   1. The constructor initialises `this.preservedMetaSnapshot = []`
    //   2. The `restore()` entry point resets it per call (no leak
    //      across consecutive runs in the singleton service instance)
    //   3. `performDatabaseRestore` assigns to `this.preservedMetaSnapshot`
    //      inside the PG branch (must run before DROP)
    //   4. The replay reads `this.preservedMetaSnapshot` — NOT a bare
    //      `preservedMeta` local — so a future refactor can't
    //      accidentally drop the snapshot half on the floor again.
    const constructorInit = lines.some((l) =>
      /this\.preservedMetaSnapshot\s*=\s*\[\s*\]/.test(l)
    );
    expect(constructorInit).toBe(true);

    const assignmentSites = lines.filter((l) =>
      /this\.preservedMetaSnapshot\s*=\s*(\[\s*\]|await\s+db)/.test(l)
    );
    // Constructor init + restore() per-run reset + the PG-branch
    // assignment from db query. Three writes.
    expect(assignmentSites.length).toBeGreaterThanOrEqual(3);

    // No stray bare `preservedMeta` local-scoped declaration in
    // performDatabaseRestore — would indicate someone re-introduced
    // the round-1 footgun.
    const dangerousLocalDecl = lines.filter((l) =>
      /^\s*(let|const)\s+preservedMeta\s*=/.test(l)
    );
    expect(dangerousLocalDecl).toEqual([]);
  });

  it('every .count() result is coerced to Number before comparison', () => {
    // PR #596 review caught a second PG-only landmine: pg-driver
    // returns COUNT(*) as a string ("16" not 16) to preserve bigint
    // precision. The original code compared `result.count !==
    // expected.rowCount` and every match flagged as a mismatch on PG.
    //
    // The fix coerces with `Number(...)` at every comparison +
    // interpolation site. This test catches a future regression where
    // a refactor uses `.count` directly in a `===` / `!==` / `>` /
    // `<` comparison without coercing.
    //
    // Heuristic: find every `.count` access in the file and make sure
    // the line either:
    //   (a) wraps it in `Number(...)`, or
    //   (b) is purely an interpolation that already coerced upstream
    //       (e.g. `validation.warnings.push(`... ${eventCountN} ...`)`
    //       where eventCountN is the coerced local), or
    //   (c) is the docstring/comment line (filtered separately).
    //
    // We approximate this by listing every `.count` reference site
    // and asserting that lines doing comparisons (`===`/`!==`/`>`/
    // `<`/`>=`/`<=`) on a raw `.count` access without `Number(...)`
    // around it are zero.
    const dangerousLines = lines
      .map((l, i) => ({ line: i + 1, text: l }))
      // Filter to lines that compare a .count result
      .filter(({ text }) => {
        // Skip comments
        if (/^\s*(\/\/|\*)/.test(text)) return false;
        // Detect a `.count` (followed by `)` for `?.count` or by space/operator)
        // being directly compared via ===/!==/>/<.
        // Match the BAD pattern: `<something>.count <op> <something>`
        // where <op> is === / !== / > / < / >= / <=
        const bareCountInComparison = /\w+\??\.count\s*(?:!==|===|>=?|<=?)\s+/;
        // ALLOW if the .count is preceded by `Number(` in the same line
        const wrappedInNumber = /Number\(\s*\w+\??\.count/;
        return bareCountInComparison.test(text) && !wrappedInNumber.test(text);
      });

    expect(dangerousLines).toEqual([]);
  });

  it('the completed-restore update sets was_successful=true', () => {
    // Without this, every successful restore ends up with
    // status='completed', was_successful=false — the dashboard's
    // "last successful restore" widget then filters out the row +
    // any future audit query gating on was_successful misses it.
    // Caught locally + maintainer PR #596 review.
    //
    // Contract: the update payload that writes status='completed' on
    // the SUCCESS branch ALSO includes was_successful: true. We pin
    // it by source inspection so any future refactor of the success
    // payload keeps both fields together.
    // The success-branch update lives AFTER performPostRestoreVerification.
    // There's also a `status: 'completed'` in the dry-run / early-return
    // path (failure handling has its own block too) — we want the
    // SUCCESS-branch one specifically.
    const verifyLine = findFirst(/performPostRestoreVerification\s*\(/);
    expect(verifyLine).toBeGreaterThan(0);

    const completedStatusLineIdx = lines
      .map((l, i) => ({ line: i + 1, text: l }))
      .find(({ line, text }) =>
        line > verifyLine && /status:\s*['"]completed['"]/.test(text)
      );
    expect(completedStatusLineIdx).toBeDefined();

    // Look in the next ~10 lines for was_successful: true. The actual
    // payload is small (no nested objects between status and the
    // closing })), so a fixed-window search is reliable.
    const window = lines.slice(
      completedStatusLineIdx.line - 1,
      completedStatusLineIdx.line + 10,
    ).join('\n');
    expect(window).toMatch(/was_successful:\s*true/);
  });

  it('npm run migrate:safe is invoked after the replay in restore()', () => {
    // Contract from PR #596 round 4: backups taken on older picpeak
    // versions must restore COMPLETELY on a newer image — even if new
    // migrations have been added since the backup was taken. The
    // restore() flow shells out to `npm run migrate:safe` AFTER the
    // operator-meta replay so the schema catches up to the running
    // code WITHIN the restore boundary (not on the next container
    // restart).
    //
    // Contract:
    //   1. A `migrate:safe` shell-out exists somewhere in restoreService
    //   2. It sits AFTER the replay drain — verification → replay →
    //      migrations is the documented order
    //   3. It does NOT sit inside performDatabaseRestore (must run
    //      against the reinit'd pool from the parent restore())
    const migrateLine = findFirst(/['"]migrate:safe['"]/);
    expect(migrateLine).toBeGreaterThan(0);

    const replayLine = findLast(/this\.preservedMetaSnapshot\.length\s*>\s*0/);
    expect(replayLine).toBeGreaterThan(0);
    expect(migrateLine).toBeGreaterThan(replayLine);

    // Must NOT live inside performDatabaseRestore (same scope as the
    // replay check above).
    const dbRestoreStart = findFirst(/async\s+performDatabaseRestore\s*\(/);
    let dbRestoreEnd = -1;
    for (let i = dbRestoreStart; i < lines.length; i++) {
      if (/^  \}\s*$/.test(lines[i])) {
        dbRestoreEnd = i + 1;
        break;
      }
    }
    expect(migrateLine < dbRestoreStart || migrateLine > dbRestoreEnd).toBe(true);
  });

  it('the replay site lives in restore() AFTER performPostRestoreVerification', () => {
    // PR #596 round 3 moved the replay out of performDatabaseRestore
    // and into the parent restore() method, sequenced AFTER the
    // post-restore verification. Otherwise the replay's upserted row
    // count was being flagged as a verification mismatch (e.g.
    // "expected 190, got 191" because the fresh-install seeded
    // `restore_allow_force_auto_upgraded` that wasn't in the backup).
    //
    // Contract: the line that drains `this.preservedMetaSnapshot`
    // must come AFTER `performPostRestoreVerification` AND must NOT
    // sit inside `performDatabaseRestore`.
    const verificationLine = findFirst(/performPostRestoreVerification\s*\(/);
    expect(verificationLine).toBeGreaterThan(0);

    const replayLine = findLast(/this\.preservedMetaSnapshot\.length\s*>\s*0/);
    expect(replayLine).toBeGreaterThan(0);
    expect(replayLine).toBeGreaterThan(verificationLine);

    // `performDatabaseRestore` must not contain the replay drain.
    // Find the function bounds + assert no drain line falls inside.
    const dbRestoreStart = findFirst(/async\s+performDatabaseRestore\s*\(/);
    expect(dbRestoreStart).toBeGreaterThan(0);

    // Find the closing brace of performDatabaseRestore. Lazy heuristic:
    // the first `^  \}\s*$` (two-space indent + }) after the function
    // start. Brittle to indent changes but unambiguous in this codebase.
    let dbRestoreEnd = -1;
    for (let i = dbRestoreStart; i < lines.length; i++) {
      if (/^  \}\s*$/.test(lines[i])) {
        dbRestoreEnd = i + 1;
        break;
      }
    }
    expect(dbRestoreEnd).toBeGreaterThan(dbRestoreStart);

    // The replay drain line must be OUTSIDE [dbRestoreStart, dbRestoreEnd].
    expect(replayLine < dbRestoreStart || replayLine > dbRestoreEnd).toBe(true);
  });
});
