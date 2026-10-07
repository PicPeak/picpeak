/**
 * Fill mode is counted (review on 1833): it stays on while any page asks for
 * it, so one consumer unmounting cannot switch it off under another, and it
 * goes off once the last one leaves.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FillViewportContext, useFillViewport, useFillViewportCounter } from '../fillViewport';

const Consumer: React.FC = () => {
  useFillViewport();
  return null;
};

const Layout: React.FC<{ a: boolean; b: boolean }> = ({ a, b }) => {
  const [fill, setFill] = useFillViewportCounter();
  return (
    <FillViewportContext.Provider value={setFill}>
      <main data-fill={fill ? 'on' : 'off'} />
      {a && <Consumer />}
      {b && <Consumer />}
    </FillViewportContext.Provider>
  );
};

const fillState = (container: HTMLElement) => container.querySelector('main')?.getAttribute('data-fill');

describe('useFillViewportCounter', () => {
  it('is off with no consumer and on while one is mounted', () => {
    const { container, rerender } = render(<Layout a={false} b={false} />);
    expect(fillState(container)).toBe('off');
    rerender(<Layout a b={false} />);
    expect(fillState(container)).toBe('on');
  });

  it('stays on while a second consumer is still mounted, and goes off after the last', () => {
    const { container, rerender } = render(<Layout a b />);
    expect(fillState(container)).toBe('on');
    rerender(<Layout a={false} b />);
    expect(fillState(container)).toBe('on');
    rerender(<Layout a={false} b={false} />);
    expect(fillState(container)).toBe('off');
  });
});
