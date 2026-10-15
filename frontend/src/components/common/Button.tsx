import React from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** One `primary` per view; `danger` for destructive actions (confirm first). */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  /** `icon-sm` / `icon-md`: square icon-only button — pass `aria-label`. */
  size?: 'sm' | 'md' | 'lg' | 'icon-sm' | 'icon-md';
  isLoading?: boolean;
  /**
   * While loading, stay focusable (aria-disabled, activation ignored) rather
   * than natively disabled, so a keyboard user's focus is not dropped by a
   * button that goes busy under it (issue 2043).
   */
  focusableWhileLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      focusableWhileLoading = false,
      disabled,
      onClick,
      leftIcon,
      rightIcon,
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles = 'btn';
    
    const variants = {
      primary: 'btn-primary',
      secondary: 'btn-secondary',
      outline: 'btn-outline',
      // .btn-ghost reads the gallery theme, or the UI tokens inside the
      // admin (.admin-ui); a utility in className still wins over either.
      ghost: 'btn-ghost',
      danger: 'btn-danger',
    };

    const sizes = {
      sm: 'btn-sm',
      md: 'btn-md',
      lg: 'btn-lg',
      'icon-sm': 'btn-icon-sm',
      'icon-md': 'btn-icon-md',
    };
    const iconOnly = size === 'icon-sm' || size === 'icon-md';

    return (
      <button
        ref={ref}
        className={clsx(
          baseStyles,
          variants[variant],
          sizes[size],
          className
        )}
        disabled={disabled || (isLoading && !focusableWhileLoading)}
        onClick={isLoading ? undefined : onClick}
        {...props}
        aria-busy={isLoading}
        aria-disabled={disabled || isLoading}
      >
        {isLoading ? (
          <Loader2 className={clsx('h-4 w-4 animate-spin', !iconOnly && 'mr-2')} aria-label="Loading" />
        ) : (
          leftIcon && <span className="mr-2" aria-hidden="true">{leftIcon}</span>
        )}
        {!(iconOnly && isLoading) && children}
        {!isLoading && rightIcon && <span className="ml-2" aria-hidden="true">{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';