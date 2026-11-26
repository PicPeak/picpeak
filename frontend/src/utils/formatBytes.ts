const BYTE_UNITS = ['Bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human-readable size ("1.5 MB"), base 1024, up to two decimals. `units`
 * lets a caller keep a shorter unit list. Not the same output as
 * utils/fileSize.formatFileSize ("Bytes" vs "B", rounding).
 */
export function formatBytes(bytes: number, units: readonly string[] = BYTE_UNITS): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}
