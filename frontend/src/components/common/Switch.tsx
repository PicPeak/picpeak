import React from 'react';
import clsx from 'clsx';

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Required when there is no visible `label`. */
  ariaLabel?: string;
  /** Visible label; clicking it flips the switch. */
  label?: React.ReactNode;
  /** One line under the label. */
  description?: React.ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  id?: string;
}

/**
 * The one on/off control (role=switch). For a setting it changes the page
 * draft and saves through the save bar, never on its own (UX.md § 2).
 * On = the studio's accent.
 */
export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  label,
  description,
  size = 'md',
  className,
  id,
}) => {
  const generatedId = React.useId();
  const switchId = id ?? generatedId;
  const control = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? `${switchId}-label` : undefined}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        'relative inline-flex flex-shrink-0 items-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent',
        size === 'sm' ? 'h-5 w-9' : 'h-6 w-11',
        checked ? 'bg-accent-strong' : 'bg-fill-strong',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={clsx(
          'inline-block transform rounded-full bg-white shadow transition-transform',
          size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4',
          checked ? (size === 'sm' ? 'translate-x-[1.125rem]' : 'translate-x-6') : 'translate-x-1',
        )}
      />
    </button>
  );
  if (!label) return <span className={className}>{control}</span>;
  return (
    <div className={clsx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label id={`${switchId}-label`} htmlFor={switchId} className="block text-sm font-medium text-body cursor-pointer">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {control}
    </div>
  );
};
