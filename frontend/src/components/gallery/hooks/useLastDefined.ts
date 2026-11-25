import { useState } from 'react';

/**
 * `value` while it is defined; otherwise the last defined value, or
 * `initial` before there was one. For a setting derived from query data that
 * should hold while the payload lacks it (a refetch, a key change).
 */
export function useLastDefined<T>(value: T | undefined, initial: T): T {
  const [last, setLast] = useState<T>(initial);
  if (value !== undefined && !Object.is(value, last)) setLast(value);
  return value === undefined ? last : value;
}
