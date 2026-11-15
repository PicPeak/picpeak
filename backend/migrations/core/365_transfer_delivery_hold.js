'use strict';
/**
 * Migration 365: hold a send's ready mail while its files are still arriving.
 *
 *   transfers.delivery_held_until  epoch ms. Set on create when the admin's
 *                                  own files follow in further requests or
 *                                  chunks; every automatic ready-mail path
 *                                  (a photo finishing, files added, a patch)
 *                                  sends nothing before it. The resend route
 *                                  clears it and sends. A page that never
 *                                  finishes leaves it to lapse, after which the
 *                                  held recipients are mailed as before.
 *
 * Additive and nullable; NULL means no hold, which every existing row gets.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('transfers') && !(await knex.schema.hasColumn('transfers', 'delivery_held_until'))) {
    await knex.schema.alterTable('transfers', (table) => {
      table.bigInteger('delivery_held_until').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('transfers') && await knex.schema.hasColumn('transfers', 'delivery_held_until')) {
    await knex.schema.alterTable('transfers', (table) => {
      table.dropColumn('delivery_held_until');
    });
  }
};
