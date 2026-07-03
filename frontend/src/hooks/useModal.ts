import { useCallback, useState } from 'react';

export interface UseModalResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

/**
 * Small helper for the ubiquitous `const [showX, setShowX] = useState(false)`
 * modal open/close flag.
 */
export function useModal(initialOpen = false): UseModalResult {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  return { isOpen, open, close, toggle };
}
