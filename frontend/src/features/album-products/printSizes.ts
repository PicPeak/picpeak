// Generic nominal sizes; production dimensions must still be verified per supplier.
// Evidence and scope: docs/print-sales-market-research.md (29 October 2026).
export type PrintSize = { id: string; group: 'metric' | 'imperial' | 'square' | 'paper'; label: string; width: number; height: number; unit: 'cm' | 'in' | 'mm' };
export const printSizes: PrintSize[] = [
  ...[[9, 13], [10, 15], [13, 18], [15, 20], [20, 25], [20, 30], [30, 40], [30, 45], [40, 50], [40, 60], [50, 70]].map(([width, height]) =>
    ({ id: `cm-${width}-${height}`, group: 'metric' as const, label: `${width} × ${height} cm`, width, height, unit: 'cm' as const })),
  ...[[3.5, 5], [4, 6], [5, 7], [6, 8], [6, 9], [8, 10], [8, 12], [10, 15], [11, 14], [12, 16], [12, 18], [16, 20], [16, 24], [18, 24], [20, 24], [20, 30]].map(([width, height]) =>
    ({ id: `in-${width}-${height}`, group: 'imperial' as const, label: `${width} × ${height} in`, width, height, unit: 'in' as const })),
  ...[10, 15, 20, 30].map(size => ({ id: `cm-${size}-square`, group: 'square' as const, label: `${size} × ${size} cm`, width: size, height: size, unit: 'cm' as const })),
  ...[4, 5, 6, 8, 10, 12, 20].map(size => ({ id: `in-${size}-square`, group: 'square' as const, label: `${size} × ${size} in`, width: size, height: size, unit: 'in' as const })),
  ...[['A6', 105, 148], ['A5', 148, 210], ['A4', 210, 297], ['A3', 297, 420], ['A2', 420, 594]].map(([name, width, height]) =>
    ({ id: String(name), group: 'paper' as const, label: `${name} (${width} × ${height} mm)`, width: Number(width), height: Number(height), unit: 'mm' as const })),
];
export function millimetres(size: Pick<PrintSize, 'width' | 'height' | 'unit'>) {
  const scale = size.unit === 'in' ? 25.4 : size.unit === 'cm' ? 10 : 1;
  return { width: Math.round(size.width * scale * 1000) / 1000, height: Math.round(size.height * scale * 1000) / 1000 };
}
