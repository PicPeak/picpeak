import React from 'react';
import { clsx } from 'clsx';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  // On a themed page (gallery, customer portal, public pages): the field, its
  // label, icons and helper text follow the operator's theme tokens. Without
  // it the field keeps the admin's `.input` colours, which on a dark gallery
  // theme left a white field under a themed label.
  themed?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      label,
      error,
      helperText,
      leftIcon,
      rightIcon,
      themed = false,
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || `input-${Math.random().toString(36).substr(2, 9)}`;

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className={clsx(
              'block text-sm font-medium mb-1.5',
              themed ? 'text-theme' : 'text-body'
            )}
          >
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <span className={themed ? 'text-muted-theme' : 'text-muted'}>{leftIcon}</span>
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={clsx(
              themed ? 'input-themed' : 'input',
              leftIcon && 'pl-10',
              rightIcon && 'pr-10',
              error && 'border-danger focus-visible:ring-accent',
              className
            )}
            aria-invalid={error ? 'true' : 'false'}
            aria-describedby={
              error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined
            }
            {...props}
          />
          {rightIcon && (
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
              <span className={themed ? 'text-muted-theme' : 'text-muted'}>{rightIcon}</span>
            </div>
          )}
        </div>
        {error && (
          <p
            id={`${inputId}-error`}
            className={clsx('mt-1.5 text-sm', themed ? 'text-status hue-danger' : 'text-danger-text')}
          >
            {error}
          </p>
        )}
        {helperText && !error && (
          <p
            id={`${inputId}-helper`}
            className={clsx('mt-1.5 text-sm', themed ? 'text-muted-theme' : 'text-muted')}
          >
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';