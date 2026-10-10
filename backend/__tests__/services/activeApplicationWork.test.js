'use strict';

const { createWorkRegistry } = require('../../src/services/activeApplicationWork');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('coordinated restore application-work drain', () => {
  it('owns the promise before the synchronous work prefix can run', async () => {
    const registry = createWorkRegistry();
    const gate = deferred();
    let started = false;
    const run = registry.track('backup', () => {
      expect(registry.pendingCount()).toBe(1);
      started = true;
      return gate.promise;
    });
    expect(started).toBe(true);
    expect(registry.pendingCount()).toBe(1);
    registry.closeAdmission();
    let drained = false;
    const wait = registry.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([run, wait]);
    expect(registry.pendingCount()).toBe(0);
  });

  it('rejects new work without invoking its write callback', async () => {
    const registry = createWorkRegistry();
    const write = jest.fn();
    registry.closeAdmission();
    await expect(registry.track('new import', write)).rejects.toMatchObject({
      code: 'RESTORE_MAINTENANCE', statusCode: 503,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('drains accepted nested work even when the parent finishes first', async () => {
    const registry = createWorkRegistry();
    const gate = deferred();
    const parentGate = deferred();
    let child;
    const parent = registry.track('accepted job', async () => {
      await parentGate.promise;
      child = registry.track('owned child', () => gate.promise);
    });
    registry.closeAdmission();
    const wait = registry.drain();
    parentGate.resolve();
    await parent;
    expect(registry.pendingCount()).toBe(1);
    gate.resolve();
    await Promise.all([child, wait]);
  });

  it('settles failed work without reopening admission or swallowing its error', async () => {
    const registry = createWorkRegistry();
    const error = new Error('I/O failure');
    const run = registry.track('failed backup', () => { throw error; });
    registry.closeAdmission();
    await expect(run).rejects.toBe(error);
    await registry.drain();
    expect(registry.isClosed()).toBe(true);
    await expect(registry.track('next writer', () => {})).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
  });

  it('reserves detached work before setImmediate and drains its async continuation', async () => {
    const registry = createWorkRegistry();
    const gate = deferred();
    let invoked = false;
    const pending = registry.defer('detached repair', async () => { invoked = true; await gate.promise; });
    expect(registry.pendingCount()).toBe(1);
    registry.closeAdmission();
    let drained = false;
    const wait = registry.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(invoked).toBe(true);
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([pending, wait]);
    expect(registry.pendingCount()).toBe(0);
  });

  it('never executes a deferred write submitted after closure', async () => {
    const registry = createWorkRegistry();
    const callback = jest.fn();
    registry.closeAdmission();
    await expect(registry.defer('rejected repair', callback)).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
    await new Promise(resolve => setImmediate(resolve));
    expect(callback).not.toHaveBeenCalled();
  });
});
