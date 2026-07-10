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
});
