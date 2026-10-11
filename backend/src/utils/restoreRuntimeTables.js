'use strict';

// These are target-local execution lifetimes and commit/read-representation
// metadata, not portable application data. Preserve their schema in native
// dumps, but never transplant another installation's live leases or epochs.
module.exports = Object.freeze([
  'portable_restore_control', 'portable_restore_instances', 'portable_restore_commits',
  'storage_s3_generation_index', 'media_process_attempts',
]);
