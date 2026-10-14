import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { LocalizedDateInput } from '../LocalizedDateInput';

// Stub the settings hook so the component doesn't need a QueryClient; falls
// back to the default DD.MM.YYYY display format. The parse/validation under
// test is separator-independent.
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ settings: {} }),
}));

describe('LocalizedDateInput', () => {
  const renderInput = (value = '2026-07-07') => {
    const onChange = vi.fn();
    render(<LocalizedDateInput value={value} onChange={onChange} />);
    const input = screen.getByDisplayValue('07.07.2026') as HTMLInputElement;
    return { input, onChange };
  };

  it('does not commit an impossible date mid-edit (regression: backspacing the day → "2026-07-00" crashed the page)', () => {
    const { input, onChange } = renderInput();
    // Backspacing a day digit leaves "0.07.2026" — a syntactically complete but
    // invalid date. It must NOT propagate (used to coerce to "2026-07-00",
    // which crashed date-fns format() downstream).
    fireEvent.change(input, { target: { value: '0.07.2026' } });
    expect(onChange).not.toHaveBeenCalled();

    // Nor may an out-of-range calendar date (31 Feb).
    fireEvent.change(input, { target: { value: '31.02.2026' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a complete, valid date as ISO', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: '15.08.2026' } });
    expect(onChange).toHaveBeenCalledWith('2026-08-15');
  });

  it('keeps the text and caret while a date is edited in place (regression: deleting a digit reformatted the field)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LocalizedDateInput value="2026-08-15" onChange={onChange} />);
    const input = screen.getByDisplayValue('15.08.2026') as HTMLInputElement;
    // Deleting the "5" leaves "1.08.2026": a valid date, but not the one meant.
    fireEvent.change(input, { target: { value: '1.08.2026' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('1.08.2026');
    // Typing the new digit commits the full date; the value coming back from
    // the parent leaves the text as typed.
    fireEvent.change(input, { target: { value: '18.08.2026' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-08-18');
    rerender(<LocalizedDateInput value="2026-08-18" onChange={onChange} />);
    expect(input.value).toBe('18.08.2026');
  });

  it('still accepts a short date on blur', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: '1.8.2026' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('2026-08-01');
  });

  it('follows a value set from outside', () => {
    const { rerender } = render(<LocalizedDateInput value="2026-08-15" onChange={vi.fn()} />);
    rerender(<LocalizedDateInput value="2026-09-01" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('01.09.2026')).toBeInTheDocument();
  });

  it('opens its own calendar (no native picker) and picks a day', () => {
    const onChange = vi.fn();
    render(<LocalizedDateInput label="Valid until" value="2026-09-10" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    const dialog = screen.getByRole('dialog', { name: 'Valid until' });
    expect(dialog.querySelector('input[type="date"]')).toBeNull();
    // The selected day holds focus, so the arrow keys work at once.
    const selected = screen.getByRole('gridcell', { selected: true }).querySelector('button')!;
    expect(document.activeElement).toBe(selected);
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('2026-09-11');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Valid until' }));
  });

  it('moves to the next month with Page Down and respects min / max', () => {
    render(<LocalizedDateInput label="Due" value="2026-09-10" min="2026-09-05" max="2026-10-05" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    const day = (iso: string) => document.querySelector(`[data-day="${iso}"]`) as HTMLButtonElement;
    expect(day('2026-09-04').disabled).toBe(true);
    expect(day('2026-09-05').disabled).toBe(false);
    // 10 October is past max: focus stops on the last day that can take it.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'PageDown' });
    expect(day('2026-10-10').disabled).toBe(true);
    expect(document.activeElement).toBe(day('2026-10-05'));
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('keeps the arrow keys alive at min (regression: focus moved to a disabled day and the keys went dead)', () => {
    render(<LocalizedDateInput label="Expires" value="2026-03-03" min="2026-03-01" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    const day = (iso: string) => document.querySelector(`[data-day="${iso}"]`) as HTMLButtonElement;
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(day('2026-03-01'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(day('2026-03-02'));
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    // Alt+Left is the browser's Back, not a day step.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft', altKey: true });
    expect(document.activeElement).toBe(day('2026-03-02'));
  });

  it('clears half-typed text when the value is reset from outside', () => {
    const { rerender } = render(<LocalizedDateInput value="2026-08-15" onChange={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('15.08.2026'), { target: { value: '15.08.20' } });
    rerender(<LocalizedDateInput value="" onChange={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('closes the calendar on Escape and on a click outside', () => {
    render(<LocalizedDateInput label="Due" value="" onChange={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Choose date' });
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Focus was on a day inside the calendar; it goes back to the button,
    // not to <body> (the next Tab would start at the top of the page).
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves the Enter that commits an IME composition to the field', () => {
    const onChange = vi.fn();
    render(<LocalizedDateInput label="Date" value="2026-07-07" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Date' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.8.2026' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('1.8.2026');
  });

  it('commits a short date on Enter, before the form submits', () => {
    let submitted = '';
    const Form = () => {
      const [v, setV] = React.useState('2026-07-07');
      return (
        <form onSubmit={(e) => { e.preventDefault(); submitted = v; }}>
          <LocalizedDateInput label="Date" value={v} onChange={setV} />
          <button type="submit">Save</button>
        </form>
      );
    };
    render(<Form />);
    const input = screen.getByRole('textbox', { name: 'Date' });
    fireEvent.change(input, { target: { value: '1.8.2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(input.closest('form')!);
    expect(submitted).toBe('2026-08-01');
  });

  it('starts the calendar on a day inside min / max', () => {
    render(<LocalizedDateInput label="Expires" value="2026-01-10" min="2026-03-01" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    expect(document.activeElement).toBe(document.querySelector('[data-day="2026-03-01"]'));
  });

  it('closes when Tab leaves the calendar', () => {
    render(
      <>
        <LocalizedDateInput label="Due" value="2026-09-10" onChange={vi.fn()} />
        <button type="button">Elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
    const day = document.activeElement as HTMLElement;
    fireEvent.blur(day, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when Tab goes past the last button, where focus would leave the page', () => {
    render(<LocalizedDateInput label="Due" value="2026-09-10" onChange={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Choose date' });
    fireEvent.click(toggle);
    const today = screen.getByRole('button', { name: 'Today' });
    // Shift+Tab from the last button stays inside.
    fireEvent.keyDown(today, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(today, { key: 'Tab' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});
