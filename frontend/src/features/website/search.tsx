/**
 * Search for the website builder's paged lists (picker, featured galleries).
 */
import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';

/** `value`, once it has stopped changing for `ms`: a search runs on a pause. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The search box above the picker's lists. */
export const SearchField: React.FC<{ value: string; onChange: (value: string) => void; label: string }> = ({ value, onChange, label }) => (
  <div className="relative">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" aria-hidden="true" />
    <input type="search" className="input pl-9" value={value} placeholder={label} aria-label={label}
      maxLength={200} onChange={(e) => onChange(e.target.value)} />
  </div>
);
