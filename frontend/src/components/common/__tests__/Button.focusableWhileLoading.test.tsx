/**
 * Issue 2043: a download button that goes busy under a keyboard user must
 * keep their focus. With focusableWhileLoading it is aria-disabled and
 * ignores activation instead of becoming natively disabled.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../Button';

describe('Button focusableWhileLoading (issue 2043)', () => {
  it('keeps focus and ignores activation while loading', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button focusableWhileLoading onClick={onClick}>Go</Button>);
    const button = screen.getByRole('button');
    button.focus();
    expect(button).toHaveFocus();

    rerender(<Button focusableWhileLoading isLoading onClick={onClick}>Go</Button>);
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(<Button focusableWhileLoading onClick={onClick}>Go</Button>);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is still natively disabled while loading without the option', () => {
    render(<Button isLoading>Go</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
