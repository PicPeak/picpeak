import React from 'react';
import clsx from 'clsx';

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}

/**
 * Accessible toggle switch (role=switch, aria-checked, keyboard-flippable).
 * Used by FeatureCard. Sized to match the spec (44×24px) — see also the
 * larger toggles in EventsTab.tsx for comparison; those are checkboxes.
 */
export const Switch: React.FC<SwitchProps> = ({ checked, onChange, disabled = false, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
    className={clsx(
      'relative inline-flex flex-shrink-0 h-6 w-11 items-center rounded-full transition-colors',
      'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500',
      checked ? 'bg-primary-600 dark:bg-primary-500' : 'bg-neutral-300 dark:bg-neutral-600',
      disabled && 'opacity-50 cursor-not-allowed',
    )}
  >
    <span
      className={clsx(
        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-6' : 'translate-x-1',
      )}
    />
  </button>
);
