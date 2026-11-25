/** Human-readable file size (1024-based), e.g. `2.4 MB`. */
export function formatFileSize(bytes: number | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * `1.5 MB` / `0 B`: up to two decimals with trailing zeros dropped, unit
 * `B` below 1 KB; any falsy input renders `0 B`. Backup and restore screens.
 */
export function formatBytesShort(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * `1.5 MB` / `0 B`: always one decimal above 1 KB (`1.0 KB`), whole bytes
 * below, capped at TB; any falsy input renders `0 B`. Backup coverage and
 * the per-path backup breakdown.
 */
export function formatBytesOneDecimal(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
