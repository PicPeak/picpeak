/**
 * A process-wide gate on concurrent authenticated image fetches (#1287).
 *
 * Gallery grids are NOT virtualized: a 546-photo event puts 546 `PhotoCard`s
 * in the DOM, each mounting its own `AuthenticatedImage` the moment its
 * IntersectionObserver fires. Scrolling through such a gallery therefore hands
 * the browser several hundred simultaneous `fetch` calls with nothing between
 * them and the connection pool.
 *
 * That is not a load the browser degrades gracefully under. The reported
 * symptom is a gallery that loads in bursts, then stops with tiles blank
 * indefinitely — no console error, no failed request, nothing in the backend
 * log, and no recovery from scrolling. A request that is queued forever is
 * *pending*, not failed, which is exactly why it leaves no trace.
 *
 * Bounding it here fixes the shape of the problem rather than one instance of
 * it: at most MAX_CONCURRENT requests are ever outstanding, the rest wait in
 * an ordinary FIFO, and every slot is released in a `finally` so a rejection
 * or an abort cannot leak one. Six matches what browsers allow per origin on
 * HTTP/1.1 anyway, so throughput on a healthy connection is unchanged — the
 * reporter measured the browser already effectively doing ~8 at a time.
 *
 * Deliberately module-level, not per-component: the point is a cap across the
 * whole page, which is the thing that was missing.
 */

const MAX_CONCURRENT = 6;

let active = 0;
const waiting: Array<() => void> = [];

/** Hand the next waiter a slot, if anyone is queued and one is free. */
function pump() {
  while (active < MAX_CONCURRENT && waiting.length > 0) {
    const next = waiting.shift();
    if (!next) break;
    active += 1;
    next();
  }
}

/**
 * Run `task` once a slot is free. The slot is released when the returned
 * promise settles, whatever way it settles.
 *
 * Callers that no longer need their result should still let it run — the work
 * is already cheap, and an AbortController on the underlying fetch is the
 * right way to cancel, not dropping the slot on the floor.
 */
export function withImageFetchSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      // Promise.resolve().then(task) rather than task() directly: a task that
      // throws SYNCHRONOUSLY would otherwise never reach the `.finally`, and
      // `active` would stay incremented. Repeat that and the pool is
      // permanently exhausted — the precise failure this queue exists to
      // prevent, reintroduced by its own release path.
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    };

    if (active < MAX_CONCURRENT) {
      active += 1;
      run();
    } else {
      waiting.push(run);
    }
  });
}

/** Test-only visibility into the gate. */
export function __imageFetchQueueState() {
  return { active, queued: waiting.length, max: MAX_CONCURRENT };
}
