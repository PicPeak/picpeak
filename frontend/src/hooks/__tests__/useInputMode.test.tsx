/**
 * The input-mode store (#1275).
 *
 * The bug it exists to fix is that `matchMedia('(hover: none) and (pointer:
 * coarse)')` answers "what is this device's primary pointer", which on
 * anything with both inputs is the wrong question. These pin the answer it
 * gives instead: whichever input was used last, corrected before the click.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { useInputMode, __inputModeTesting } from '../useInputMode';

/** Report a primary pointer, the way a device advertises itself. */
function stubPrimaryPointer(coarse: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query.includes('pointer: coarse'),
      media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
    }),
  });
  __inputModeTesting.reset();
}

function pointer(type: 'pointerdown' | 'pointermove', pointerType: string) {
  act(() => {
    const event = new Event(type, { bubbles: true }) as any;
    event.pointerType = pointerType;
    window.dispatchEvent(event);
  });
}

const Probe: React.FC = () => <span data-testid="mode">{useInputMode()}</span>;
const mode = () => screen.getByTestId('mode').textContent;

beforeEach(() => stubPrimaryPointer(false));
afterEach(() => vi.restoreAllMocks());

describe('useInputMode', () => {
  it('starts from the primary pointer, which is right for single-input devices', () => {
    render(<Probe />);
    expect(mode()).toBe('mouse');

    stubPrimaryPointer(true);
    render(<Probe />);
    expect(screen.getAllByTestId('mode')[1].textContent).toBe('touch');
  });

  it('follows the input in use, in both directions', () => {
    render(<Probe />);
    expect(mode()).toBe('mouse');

    pointer('pointerdown', 'touch');
    expect(mode()).toBe('touch');

    pointer('pointermove', 'mouse');
    expect(mode()).toBe('mouse');

    pointer('pointerdown', 'touch');
    expect(mode()).toBe('touch');
  });

  it('classifies an approaching mouse before it clicks', () => {
    // The whole point of listening to pointermove as well: a mouse announces
    // itself by moving, and the mode has to be right BEFORE the click, not as
    // a consequence of it.
    stubPrimaryPointer(true);
    render(<Probe />);
    expect(mode()).toBe('touch');

    pointer('pointermove', 'mouse');
    expect(mode()).toBe('mouse');
  });

  it('groups a pen with touch, since it taps rather than hovers', () => {
    render(<Probe />);
    pointer('pointerdown', 'pen');
    expect(mode()).toBe('touch');
  });

  it('ignores a pointer type it does not recognise', () => {
    render(<Probe />);
    pointer('pointerdown', '');
    expect(mode()).toBe('mouse');
  });

  it('shares one mode, and one listener pair, across every subscriber', () => {
    // A gallery renders this hook once per tile. The listeners must not scale
    // with the tile count, and two tiles must never disagree about the input.
    const { unmount } = render(<><Probe /><Probe /><Probe /></>);
    expect(__inputModeTesting.subscriberCount()).toBe(3);

    pointer('pointerdown', 'touch');
    expect(screen.getAllByTestId('mode').map((n) => n.textContent))
      .toEqual(['touch', 'touch', 'touch']);

    unmount();
    expect(__inputModeTesting.subscriberCount()).toBe(0);
  });

  it('stops listening once nothing is subscribed', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const { unmount } = render(<Probe />);
    const pointerAdds = add.mock.calls.filter(([type]) => String(type).startsWith('pointer'));
    expect(pointerAdds.map(([type]) => type).sort()).toEqual(['pointerdown', 'pointermove']);

    unmount();
    const pointerRemoves = remove.mock.calls.filter(([type]) => String(type).startsWith('pointer'));
    expect(pointerRemoves.map(([type]) => type).sort()).toEqual(['pointerdown', 'pointermove']);
  });

  it('falls back to touch signals where matchMedia is missing', () => {
    delete (window as any).matchMedia;
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    __inputModeTesting.reset();
    render(<Probe />);
    expect(mode()).toBe('touch');
  });
});
