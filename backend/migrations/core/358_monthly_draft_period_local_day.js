'use strict';
/**
 * Migration 358: open monthly drafts' billing period on the cadence's days.
 *
 * Drafts stored their period as toISOString() of local midnight, the day
 * before east of UTC, so the invoice printed a service period one day early.
 * The code now stores the local day, and the scheduler compares with the
 * local day, which would fire an old draft one day before its cadence day.
 * This moves the stored days of open drafts that are one day before the days
 * the cadence names (utils/monthlyDraftPeriods, which the portable import runs
 * again after loading an older archive). Issued invoices keep their period.
 *
 * A re-run finds nothing left to move.
 */
const { repairMonthlyDraftPeriods } = require('../../src/utils/monthlyDraftPeriods');

exports.up = async function up(knex) {
  await repairMonthlyDraftPeriods(knex, { actor: 'upgrade' });
};

// Nothing to undo: the moved days are the ones the cadence names, and the
// code before this migration would read them as a period one day later. The
// drafts' history records each move.
exports.down = async function down() {};
