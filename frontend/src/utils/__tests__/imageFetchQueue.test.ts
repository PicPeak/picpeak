/**
 * The concurrent-image-fetch gate (#1287).
 *
 * Gallery grids are not virtualized, so a several-hundred-photo event mounts
 * every tile and each one fetches. The reported failure was a gallery that
 * loaded in bursts and then stopped with tiles blank forever, leaving no
 * error and no failed request — the signature of requests queued indefinitely
 * rather than rejected.
 *
 * What has to hold for this gate to be safe on that path: the cap is never
 * exceeded, every slot is released however the task settles (a leaked slot
 * would reproduce the exact stall it is meant to prevent), and the queue
 * drains in order.
 */
import { describe, it, expect } from 'vitest';
import { withImageFetchSlot, __imageFetchQueueState } from '../imageFetchQueue';

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('withImageFetchSlot', () => {
  it('runs a task and returns its value', async () => {
    await expect(withImageFetchSlot(async () => 'ok')).resolves.toBe('ok');
  });

  it('never exceeds the concurrency cap', async () => {
    const { max } = __imageFetchQueueState();
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: max * 4 }, () => deferred<void>());

    const tasks = gates.map((g) => withImageFetchSlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await g.promise;
      running -= 1;
    }));

    await flush();
    expect(peak).toBe(max);
    expect(__imageFetchQueueState().active).toBe(max);

    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
    expect(peak).toBe(max);
  });

  it('queues the overflow and drains it', async () => {
    const { max } = __imageFetchQueueState();
    const gates = Array.from({ length: max + 3 }, () => deferred<void>());
    const started: number[] = [];

    const tasks = gates.map((g, i) => withImageFetchSlot(async () => {
      started.push(i);
      await g.promise;
    }));

    await flush();
    expect(started).toHaveLength(max);
    expect(__imageFetchQueueState().queued).toBe(3);

    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
    expect(started).toHaveLength(max + 3);
  });

  it('starts queued tasks in FIFO order', async () => {
    const { max } = __imageFetchQueueState();
    const blockers = Array.from({ length: max }, () => deferred<void>());
    const order: string[] = [];

    const held = blockers.map((g) => withImageFetchSlot(() => g.promise));
    await flush();

    const queued = ['a', 'b', 'c'].map((label) =>
      withImageFetchSlot(async () => { order.push(label); }));

    blockers.forEach((g) => g.resolve());
    await Promise.all([...held, ...queued]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('releases the slot when a task rejects', async () => {
    // The regression this guards: a leaked slot on the failure path drains
    // the pool over a long scroll and stalls the grid permanently — which is
    // the bug, reintroduced by the fix for it.
    const { max } = __imageFetchQueueState();
    await Promise.all(
      Array.from({ length: max * 2 }, () =>
        withImageFetchSlot(async () => { throw new Error('boom'); }).catch(() => undefined))
    );

    expect(__imageFetchQueueState().active).toBe(0);
    expect(__imageFetchQueueState().queued).toBe(0);
  });

  it('releases the slot when a task rejects with an abort', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await withImageFetchSlot(async () => { throw abort; }).catch(() => undefined);

    expect(__imageFetchQueueState().active).toBe(0);
  });

  it('propagates the rejection to the caller', async () => {
    await expect(withImageFetchSlot(async () => { throw new Error('nope'); }))
      .rejects.toThrow('nope');
  });

  it('returns to fully idle after a burst', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withImageFetchSlot(async () => i).catch(() => undefined))
    );

    const state = __imageFetchQueueState();
    expect(state.active).toBe(0);
    expect(state.queued).toBe(0);
  });

  it('keeps working after a mixed burst of successes and failures', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        withImageFetchSlot(async () => {
          if (i % 3 === 0) throw new Error('boom');
          return i;
        }).catch(() => undefined))
    );

    expect(__imageFetchQueueState().active).toBe(0);
    await expect(withImageFetchSlot(async () => 'still works')).resolves.toBe('still works');
  });
});
