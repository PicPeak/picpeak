import { describe, it, expect } from 'vitest';
import { batchFilesForUpload } from '../uploadBatches';

const MiB = 1024 * 1024;
const file = (name: string, size: number) => ({ name, size });

describe('batchFilesForUpload', () => {
  it('keeps a selection that fits the request budget in one request', () => {
    const files = [file('a', MiB), file('b', MiB)];
    expect(batchFilesForUpload(files, 95 * MiB, 25)).toEqual([files]);
  });
  it('splits 25 files of the maximum size so no request exceeds the budget', () => {
    const files = Array.from({ length: 25 }, (_, i) => file(`f${i}`, 50 * MiB));
    const batches = batchFilesForUpload(files, 95 * MiB, 25);
    expect(batches).toHaveLength(25);
    expect(batches.flat()).toEqual(files);
  });
  it('packs small files up to the budget and keeps their order', () => {
    const files = Array.from({ length: 6 }, (_, i) => file(`f${i}`, 30 * MiB));
    const batches = batchFilesForUpload(files, 95 * MiB, 25);
    expect(batches.map((b) => b.length)).toEqual([3, 3]);
    for (const batch of batches) expect(batch.reduce((n, f) => n + f.size, 0)).toBeLessThan(95 * MiB);
    expect(batches.flat()).toEqual(files);
  });
  it('honours the per-request file count', () => {
    const files = Array.from({ length: 5 }, (_, i) => file(`f${i}`, 10));
    expect(batchFilesForUpload(files, 95 * MiB, 2).map((b) => b.length)).toEqual([2, 2, 1]);
  });
  it('gives an over-budget file its own request instead of dropping it', () => {
    const files = [file('small', 10), file('huge', 200 * MiB), file('tail', 10)];
    expect(batchFilesForUpload(files, 95 * MiB, 25).map((b) => b.map((f) => f.name))).toEqual([['small'], ['huge'], ['tail']]);
  });
});
