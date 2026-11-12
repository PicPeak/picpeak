import { expect, it } from 'vitest';
import { printSizes, millimetres } from '../printSizes';
it('keeps exact inch, nominal metric and ISO sizes distinct', () => {
  expect(millimetres(printSizes.find(s => s.id === 'in-4-6')!)).toEqual({ width: 101.6, height: 152.4 });
  expect(millimetres(printSizes.find(s => s.id === 'cm-10-15')!)).toEqual({ width: 100, height: 150 });
  expect(millimetres(printSizes.find(s => s.id === 'A4')!)).toEqual({ width: 210, height: 297 });
  expect(new Set(printSizes.map(s => s.id)).size).toBe(printSizes.length);
});
