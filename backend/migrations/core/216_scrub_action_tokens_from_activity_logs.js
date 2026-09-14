/**
 * Migration 216: remove raw contract and quote action tokens from
 * activity_logs.metadata.
 *
 * Sending a contract (`contract_sent`) and a customer signature
 * (`contract_signed_by_customer`) logged the signing link's token in the
 * activity metadata, and `quote_sent` plus the customer's quote answer
 * (`quote_accepted` / `quote_declined`) did the same until the quote side was
 * fixed. That metadata is served verbatim by the admin notifications feed, the
 * dashboard activity feed and the contract audit trail, so anyone with read
 * access to those views held a bearer token for the customer's link.
 *
 * New writes log the token's row id instead. This scrubs the rows already on
 * disk: the `token` key is removed and, when the token still maps to an action
 * token row, replaced by that row's `tokenId` so the audit link survives.
 *
 * Rows are found by a text match on the serialized metadata (the column is
 * `json` in the bootstrap schema and text elsewhere, so it is cast for the
 * match) and processed in id-ordered batches. Re-running finds nothing left to
 * change. Irreversible by design: the removed value is a credential.
 */
const BATCH = 500;
const TOKEN_TABLES = { contract: 'contract_action_tokens', quote: 'quote_action_tokens' };

function parseMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('activity_logs'))) return;
  if (!(await knex.schema.hasColumn('activity_logs', 'metadata'))) return;

  let lastId = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await knex('activity_logs')
      .where('id', '>', lastId)
      .andWhere((qb) => qb.where('activity_type', 'like', 'contract_%').orWhere('activity_type', 'like', 'quote_%'))
      .andWhereRaw('CAST(metadata AS TEXT) LIKE ?', ['%"token"%'])
      .orderBy('id', 'asc')
      .limit(BATCH)
      .select('id', 'activity_type', 'metadata');
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      const meta = parseMetadata(row.metadata);
      if (!meta || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, 'token')) continue;
      const kind = String(row.activity_type).startsWith('contract_') ? 'contract' : 'quote';
      const table = TOKEN_TABLES[kind];
      const { token, ...rest } = meta;
      if (typeof token === 'string' && token && rest.tokenId == null
        // eslint-disable-next-line no-await-in-loop
        && await knex.schema.hasTable(table)) {
        // eslint-disable-next-line no-await-in-loop
        const tokenRow = await knex(table).where({ token }).select('id').first();
        if (tokenRow) rest.tokenId = tokenRow.id;
      }
      // eslint-disable-next-line no-await-in-loop
      await knex('activity_logs').where({ id: row.id }).update({ metadata: JSON.stringify(rest) });
    }
    if (rows.length < BATCH) break;
  }
};

// Irreversible by design: putting the token back would restore a credential
// to views that admins without contract or quote permissions can read.
exports.down = async function down() {};
