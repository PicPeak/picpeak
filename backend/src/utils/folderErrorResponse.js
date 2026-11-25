const { FolderError } = require('../services/folderTreeService');
const { errorResponse } = require('./routeHelpers');

/**
 * Answer a folder-tree rule violation with its own status, message, code and
 * details; anything else is a 500 with `fallback` as the message.
 */
function sendFolderError(res, err, fallback) {
  if (err instanceof FolderError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details || {}) });
  }
  return errorResponse(res, err, 500, fallback);
}

module.exports = { sendFolderError };
