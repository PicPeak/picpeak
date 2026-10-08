/**
 * Rotate pre-hardening PicTransfer upload codes.
 *
 * Older releases issued six-character public upload codes. They are bearer
 * credentials, so every stored code shorter than the current ten-character
 * format is replaced before the route starts rejecting the legacy shape.
 *
 * The upload links already sent for those transfers stop working, so the
 * rotated transfers are logged once for the operator to re-send them.
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

  const rows = await knex('transfers').whereNotNull('upload_token')
    .select('id', 'title', 'upload_token');
  const rotated = [];
  for (const row of rows) {
    // An empty value never matched the public route; leave it dead rather
    // than turn it into a live code.
    if (!row.upload_token) continue;
    if (String(row.upload_token).length >= MIN_LENGTH) continue;
    await knex('transfers').where({ id: row.id }).update({
      upload_token: await uniqueCode(knex, row.id),
      updated_at: knex.fn.now(),
    });
    rotated.push(row);
  }

  // The old links are dead now, so name the transfers for the operator.
  if (rotated.length) {
    console.log(`Migration 272: rotated ${rotated.length} legacy transfer upload code(s); `
      + 're-send the upload link for: '
      + rotated.map((row) => `#${row.id} ${JSON.stringify(row.title || '')}`).join(', '));
  }
};

// Rotated bearer credentials cannot be reconstructed safely.
exports.down = async function down() {};
