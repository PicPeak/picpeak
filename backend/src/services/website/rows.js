/**
 * The two rows of website_documents (issue 2618): the draft and the
 * published document, each one JSON document.
 */
const { db } = require('../../database/db');

function parseDocument(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.document);
  } catch {
    return null;
  }
}

async function readRow(state, conn = db) {
  return conn('website_documents').where({ state }).first();
}

module.exports = { parseDocument, readRow };
