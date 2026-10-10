'use strict';

// These controls isolate promise ownership from admission/filesystem controls,
// which have separate real-Linux kernel-lease integration coverage.
jest.mock('../../src/services/portableRestoreIngress', () => ({
  withIngress: jest.fn(run => run()),
}), { virtual: true });
jest.mock('../../src/services/portableRestoreCoordinator', () => ({
  admitUpload: jest.fn(async () => {}), isRegistered: jest.fn(() => false),
}));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));

const applicationWork = require('../../src/services/activeApplicationWork');
const ingress = require('../../src/services/portableRestoreIngress');
const coordinator = require('../../src/services/portableRestoreCoordinator');
const { RestoreService } = require('../../src/services/restoreService');
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('detached native restore has a whole-operation maintenance owner', () => {
  beforeEach(() => { applicationWork.openAdmission(); jest.clearAllMocks(); });
  afterEach(async () => { applicationWork.openAdmission(); await applicationWork.drain(); });

  test('cannot ACK while accepted restore is between database and terminal file I/O', async () => {
    let finish;
    const terminal = new Promise(resolve => { finish = resolve; });
    const service = new RestoreService();
    service.performRestore = jest.fn(async () => { await terminal; return { success: true }; });
    const restore = service.restore({ restoreType: 'full' });
    await tick();
    expect(service.performRestore).toHaveBeenCalledTimes(1);
    expect(coordinator.admitUpload).toHaveBeenCalledTimes(1);
    applicationWork.closeAdmission();
    let drained = false;
    const drain = applicationWork.drain().then(() => { drained = true; });
    await tick();
    await tick();
    expect(drained).toBe(false);
    finish();
    await expect(restore).resolves.toEqual({ success: true });
    await drain;
    expect(drained).toBe(true);
  });

  test('runs exactly as before on a runtime that takes no part in a portable restore: no ingress slot, no lease', async () => {
    const service = new RestoreService();
    service.performRestore = jest.fn(async () => ({ success: true }));
    await expect(service.restore({ restoreType: 'full' })).resolves.toEqual({ success: true });
    await expect(service.restoreDuringStartup({ restoreType: 'full' })).resolves.toEqual({ success: true });
    expect(ingress.withIngress).not.toHaveBeenCalled();
    expect(service.performRestore).toHaveBeenCalledTimes(2);
  });

  test('holds the shared ingress slot and re-checks the fence once this runtime is registered', async () => {
    coordinator.isRegistered.mockReturnValue(true);
    try {
      const service = new RestoreService();
      service.performRestore = jest.fn(async () => ({ success: true }));
      await expect(service.restore({ restoreType: 'full' })).resolves.toEqual({ success: true });
      expect(ingress.withIngress).toHaveBeenCalledTimes(1);
      expect(coordinator.admitUpload).toHaveBeenCalledTimes(2);
    } finally { coordinator.isRegistered.mockReturnValue(false); }
  });

  test('a closed fence never reaches any native mutation', async () => {
    coordinator.admitUpload.mockRejectedValueOnce(new Error('durable fence is closed'));
    const service = new RestoreService();
    service.performRestore = jest.fn();
    await expect(service.restore({})).rejects.toThrow('durable fence is closed');
    expect(service.performRestore).not.toHaveBeenCalled();
    await applicationWork.drain();
    expect(applicationWork.pendingCount()).toBe(0);
  });

  test('a new detached restore is rejected after ordinary admission closes', async () => {
    applicationWork.closeAdmission();
    const service = new RestoreService();
    service.performRestore = jest.fn();
    await expect(service.restore({})).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    expect(ingress.withIngress).not.toHaveBeenCalled();
    expect(service.performRestore).not.toHaveBeenCalled();
  });
});
