/**
 * Rotate pre-hardening PicTransfer upload codes.
 *
 * Older releases issued six-character public upload codes. They are bearer
 * credentials, so every stored code shorter than the current ten-character
 * format is replaced before the route starts rejecting the legacy shape.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MIN_LENGTH = 10;

function candidate() {
  let value = '';
  for (let i = 0; i < MIN_LENGTH; i += 1) {
    value += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return value;
}

async function uniqueCode(knex, transferId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = candidate();
    const clash = await knex('transfers').where({ upload_token: value })
      .whereNot({ id: transferId }).first('id');
    if (!clash) return value;
  }
  throw new Error('Could not rotate a unique transfer upload code');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('transfers'))
    || !(await knex.schema.hasColumn('transfers', 'upload_token'))) return;

  const rows = await knex('transfers').whereNotNull('upload_token').select('id', 'upload_token');
  for (const row of rows) {
    if (String(row.upload_token).length >= MIN_LENGTH) continue;
    await knex('transfers').where({ id: row.id }).update({
      upload_token: await uniqueCode(knex, row.id),
      updated_at: knex.fn.now(),
    });
  }
};

// Rotated bearer credentials cannot be reconstructed safely.
exports.down = async function down() {};
