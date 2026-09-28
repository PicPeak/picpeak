'use strict';

// Download statistics are best-effort writes that used to end in
// `.catch(() => {})`, so a broken counter never showed up anywhere. Every such
// write now reports the failure through the logger.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const logger = require('../../src/utils/logger');
const { _internal } = require('../../src/routes/gallery/downloads');

it('reports a failed statistics write instead of swallowing it', () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  _internal.statsWriteFailed('photo download count')(new Error('SQLITE_BUSY: database is locked'));
  expect(warn).toHaveBeenCalledWith('Download stats not recorded (photo download count)', { error: 'SQLITE_BUSY: database is locked' });
  warn.mockRestore();
});

it('no download statistics write is left with an empty catch', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/routes/gallery/downloads.js'), 'utf8');
  const silent = src.split('\n').filter((l) => l.includes('.catch(() => {})') && !l.includes('abortStreamingArchive'));
  expect(silent).toEqual([]);
});
