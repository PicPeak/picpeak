'use strict';
jest.mock('../../src/database/db', () => ({ db: { schema: { hasTable: jest.fn(async () => true) }, transaction: jest.fn(async () => null) } }));
jest.mock('../../src/services/storage', () => ({ getStorage: () => ({}) }));
jest.mock('../../src/services/printSales/files', () => ({ sweepDownloads: jest.fn(async () => { throw Object.assign(new Error('Private temporary directory unavailable'), { code: 'EACCES' }); }) }));
jest.mock('../../src/services/printSales/fulfilment', () => ({ createService: () => ({ cleanup: mockRetention }) }));
jest.mock('../../src/services/printSales/downloadStatus', () => ({ createService: () => ({ cleanup: mockStatuses }) }));
const mockRetention = jest.fn(async () => {}), mockStatuses = jest.fn(async () => {});
test('a temporary-copy sweep error never suppresses retention or floods later ticks', async () => {
  jest.useFakeTimers();
  const worker = require('../../src/services/printSales/worker'), { sweepDownloads } = require('../../src/services/printSales/files');
  try {
    worker.start(); await jest.advanceTimersByTimeAsync(10000);
    expect(sweepDownloads).toHaveBeenCalledTimes(1); expect(mockRetention).toHaveBeenCalledTimes(1); expect(mockStatuses).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10000);
    expect(sweepDownloads).toHaveBeenCalledTimes(1); expect(mockRetention).toHaveBeenCalledTimes(2);
  } finally { await worker.stop(); jest.useRealTimers(); }
});
