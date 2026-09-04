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

  it('releases the slot when a task throws SYNCHRONOUSLY', async () => {
    // A task that throws before returning a promise used to bypass the
    // `.finally` release entirely, leaving `active` incremented. Repeat that
    // and the pool is permanently exhausted — the stall this queue exists to
    // prevent, reintroduced by its own release path.
    const { max } = __imageFetchQueueState();

    await Promise.all(
      Array.from({ length: max * 2 }, () =>
        withImageFetchSlot((() => { throw new Error('sync boom'); }) as unknown as () => Promise<void>)
          .catch(() => undefined))
    );

    expect(__imageFetchQueueState().active).toBe(0);
    expect(__imageFetchQueueState().queued).toBe(0);
    await expect(withImageFetchSlot(async () => 'alive')).resolves.toBe('alive');
  });

  it('a synchronous throw from a QUEUED task does not wedge the pump', async () => {
    const { max } = __imageFetchQueueState();
    const blockers = Array.from({ length: max }, () => deferred<void>());
    const held = blockers.map((g) => withImageFetchSlot(() => g.promise));
    await flush();

    // Queued behind the blockers, so it runs from pump() rather than inline.
    const queued = withImageFetchSlot(
      (() => { throw new Error('sync boom'); }) as unknown as () => Promise<void>
    ).catch(() => 'rejected');

    blockers.forEach((g) => g.resolve());
    await Promise.all(held);
    await expect(queued).resolves.toBe('rejected');
    expect(__imageFetchQueueState().active).toBe(0);
  });

  it('holds the slot until the task fully settles, not just its first await', async () => {
    // #1287 review: `fetch` resolves on HEADERS. If the slot were released
    // there, the cap would bound header round-trips while bodies streamed
    // unbounded. The gate must stay held for the whole task.
    const { max } = __imageFetchQueueState();
    const headers = Array.from({ length: max }, () => deferred<void>());
    const bodies = Array.from({ length: max }, () => deferred<void>());
    let started = 0;

    const tasks = headers.map((h, i) => withImageFetchSlot(async () => {
      started += 1;
      await h.promise;         // "headers arrived"
      await bodies[i].promise; // "body consumed"
    }));

    await flush();
    expect(started).toBe(max);

    const extra = withImageFetchSlot(async () => { started += 1; });

    // Headers in, bodies still streaming: no slot may free up.
    headers.forEach((h) => h.resolve());
    await flush();
    expect(started).toBe(max);

    bodies.forEach((b) => b.resolve());
    await Promise.all([...tasks, extra]);
    expect(started).toBe(max + 1);
  });

  describe('priority', () => {
    // Round-2 review: a single FIFO put the image the user just clicked
    // behind every thumbnail already enqueued. On a 546-photo gallery — and
    // Masonry/Timeline/Mosaic enqueue every card at once, since they pass no
    // `lazy` — that is minutes of waiting for the one image being looked at.
    it('serves a high-priority task ahead of an existing backlog', async () => {
      const { max } = __imageFetchQueueState();
      const blockers = Array.from({ length: max }, () => deferred<void>());
      const held = blockers.map((g) => withImageFetchSlot(() => g.promise));
      await flush();

      const order: string[] = [];
      // A realistic backlog of grid thumbnails...
      const normal = Array.from({ length: 20 }, (_, i) =>
        withImageFetchSlot(async () => { order.push(`thumb${i}`); }));
      // ...then the lightbox opens.
      const high = withImageFetchSlot(async () => { order.push('lightbox'); }, { priority: 'high' });

      blockers.forEach((g) => g.resolve());
      await Promise.all([...held, ...normal, high]);

      expect(order[0]).toBe('lightbox');
    });

    it('serves the current slide before its own neighbour prefetches', async () => {
      // Round-3 review: the lightbox's effects enqueue in slide order
      // (previous, current, next). With neighbours on the same tier as the
      // current slide, the PREVIOUS one took the first freed slot and the
      // image actually on screen waited behind an off-screen prefetch.
      const { max } = __imageFetchQueueState();
      const blockers = Array.from({ length: max }, () => deferred<void>());
      const held = blockers.map((g) => withImageFetchSlot(() => g.promise));
      await flush();

      const order: string[] = [];
      // Enqueued in the order the lightbox mounts them.
      const prev = withImageFetchSlot(async () => { order.push('prev'); }, { priority: 'prefetch' });
      const current = withImageFetchSlot(async () => { order.push('current'); }, { priority: 'high' });
      const next = withImageFetchSlot(async () => { order.push('next'); }, { priority: 'prefetch' });

      blockers.forEach((g) => g.resolve());
      await Promise.all([...held, prev, current, next]);

      expect(order[0]).toBe('current');
      // Neighbours keep their own FIFO below it.
      expect(order.slice(1)).toEqual(['prev', 'next']);
    });

    it('serves prefetch ahead of grid thumbnails', async () => {
      const { max } = __imageFetchQueueState();
      const blockers = Array.from({ length: max }, () => deferred<void>());
      const held = blockers.map((g) => withImageFetchSlot(() => g.promise));
      await flush();

      const order: string[] = [];
      const thumbs = Array.from({ length: 5 }, (_, i) =>
        withImageFetchSlot(async () => { order.push(`thumb${i}`); }));
      const prefetch = withImageFetchSlot(async () => { order.push('prefetch'); }, { priority: 'prefetch' });

      blockers.forEach((g) => g.resolve());
      await Promise.all([...held, ...thumbs, prefetch]);

      expect(order[0]).toBe('prefetch');
    });

    it('still respects the concurrency cap for high-priority work', async () => {
      const { max } = __imageFetchQueueState();
      let running = 0;
      let peak = 0;
      const gates = Array.from({ length: max * 3 }, () => deferred<void>());

      const tasks = gates.map((g) => withImageFetchSlot(async () => {
        running += 1; peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
      }, { priority: 'high' }));

      await flush();
      expect(peak).toBe(max);
      gates.forEach((g) => g.resolve());
      await Promise.all(tasks);
    });

    it('keeps high-priority tasks in FIFO order among themselves', async () => {
      const { max } = __imageFetchQueueState();
      const blockers = Array.from({ length: max }, () => deferred<void>());
      const held = blockers.map((g) => withImageFetchSlot(() => g.promise));
      await flush();

      const order: string[] = [];
      const queued = ['a', 'b', 'c'].map((label) =>
        withImageFetchSlot(async () => { order.push(label); }, { priority: 'high' }));

      blockers.forEach((g) => g.resolve());
      await Promise.all([...held, ...queued]);
      expect(order).toEqual(['a', 'b', 'c']);
    });

    it('does not starve the normal tier once the high tier drains', async () => {
      const { max } = __imageFetchQueueState();
      const blockers = Array.from({ length: max }, () => deferred<void>());
      const held = blockers.map((g) => withImageFetchSlot(() => g.promise));
      await flush();

      const done: string[] = [];
      const normal = withImageFetchSlot(async () => { done.push('normal'); });
      const high = withImageFetchSlot(async () => { done.push('high'); }, { priority: 'high' });

      blockers.forEach((g) => g.resolve());
      await Promise.all([...held, normal, high]);

      expect(done).toEqual(['high', 'normal']);
      expect(__imageFetchQueueState().active).toBe(0);
    });
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
