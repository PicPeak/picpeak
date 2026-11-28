/**
 * The builder's text areas grow with their text (issue 2618), from at least
 * the rows they ask for, so a long text is read without an inner scrollbar.
 */
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TextArea } from '../fields';

const original = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight');
afterEach(() => { if (original) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', original); });

it('takes the height of its text, and never hides it behind a scrollbar', () => {
  let height = 120;
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => height });
  const Holder = () => {
    const [value, setValue] = React.useState('short');
    return <TextArea label="Body" value={value} rows={6} onChange={setValue} />;
  };
  render(<Holder />);
  const box = screen.getByLabelText('Body') as HTMLTextAreaElement;
  expect(box.style.height).toBe('120px');
  expect(box.style.overflowY).toBe('hidden');
  expect(box.rows).toBe(6);
  height = 340;
  fireEvent.change(box, { target: { value: 'a much longer text\n'.repeat(12) } });
  expect(box.style.height).toBe('340px');
});
