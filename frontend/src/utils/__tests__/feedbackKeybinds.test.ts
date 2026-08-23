import { describe, it, expect } from 'vitest';
import {
  resolveFeedbackKey,
  colorShortcutHints,
  isTypingTarget,
} from '../feedbackKeybinds';

/**
 * Proofing shortcuts (#1044). Two schemes share the same digit keys, so the
 * mapping is the whole feature — and the guards matter as much as the map:
 * a bare digit must not relabel a photo while someone is typing into the
 * filename search, and Cmd+1 must stay a browser tab switch.
 */

const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent('keydown', { key: k, ...init });

const ALL_ON = { allowColorLabels: true, allowRatings: true } as const;

describe('resolveFeedbackKey — colours-only scheme', () => {
  const opts = { mode: 'colors' as const, ...ALL_ON };

  it('maps 1/2/3 to 1st choice / 2nd choice / rejected', () => {
    expect(resolveFeedbackKey(key('1'), opts)).toEqual({ type: 'color', color: 'green' });
    expect(resolveFeedbackKey(key('2'), opts)).toEqual({ type: 'color', color: 'yellow' });
    expect(resolveFeedbackKey(key('3'), opts)).toEqual({ type: 'color', color: 'red' });
  });

  it('leaves 4-9 unbound even when ratings are enabled', () => {
    for (const k of ['4', '5', '6', '7', '8', '9']) {
      expect(resolveFeedbackKey(key(k), opts)).toBeNull();
    }
  });

  it('clears the colour with 0', () => {
    expect(resolveFeedbackKey(key('0'), opts)).toEqual({ type: 'clear' });
  });
});

describe('resolveFeedbackKey — Lightroom scheme', () => {
  const opts = { mode: 'lightroom' as const, ...ALL_ON };

  it('maps 1-5 to star ratings', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(resolveFeedbackKey(key(String(n)), opts)).toEqual({ type: 'rating', value: n });
    }
  });

  it('maps 6-9 to red / yellow / green / blue', () => {
    expect(resolveFeedbackKey(key('6'), opts)).toEqual({ type: 'color', color: 'red' });
    expect(resolveFeedbackKey(key('7'), opts)).toEqual({ type: 'color', color: 'yellow' });
    expect(resolveFeedbackKey(key('8'), opts)).toEqual({ type: 'color', color: 'green' });
    expect(resolveFeedbackKey(key('9'), opts)).toEqual({ type: 'color', color: 'blue' });
  });

  it('clears the rating with 0, matching Lightroom', () => {
    expect(resolveFeedbackKey(key('0'), opts)).toEqual({ type: 'rating', value: 0 });
  });
});

describe('resolveFeedbackKey — gating', () => {
  it('ignores colour keys when colour labels are off', () => {
    expect(resolveFeedbackKey(key('1'), {
      mode: 'colors', allowColorLabels: false, allowRatings: true,
    })).toBeNull();
  });

  it('ignores star keys when ratings are off', () => {
    expect(resolveFeedbackKey(key('4'), {
      mode: 'lightroom', allowColorLabels: true, allowRatings: false,
    })).toBeNull();
    // …but the colour keys of the same scheme still work.
    expect(resolveFeedbackKey(key('8'), {
      mode: 'lightroom', allowColorLabels: true, allowRatings: false,
    })).toEqual({ type: 'color', color: 'green' });
  });

  it('falls back to the colours scheme for an unknown mode', () => {
    expect(resolveFeedbackKey(key('1'), {
      mode: 'nonsense' as unknown as 'colors', ...ALL_ON,
    })).toEqual({ type: 'color', color: 'green' });
  });

  it('never fires with a modifier held — Cmd+1 stays a tab switch', () => {
    const opts = { mode: 'colors' as const, ...ALL_ON };
    expect(resolveFeedbackKey(key('1', { metaKey: true }), opts)).toBeNull();
    expect(resolveFeedbackKey(key('1', { ctrlKey: true }), opts)).toBeNull();
    expect(resolveFeedbackKey(key('1', { altKey: true }), opts)).toBeNull();
  });

  it('never fires while the user is typing', () => {
    const opts = { mode: 'colors' as const, ...ALL_ON };
    for (const tag of ['input', 'textarea', 'select']) {
      const element = document.createElement(tag);
      const event = key('1');
      Object.defineProperty(event, 'target', { value: element });
      expect(resolveFeedbackKey(event, opts)).toBeNull();
    }

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom doesn't derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    const event = key('1');
    Object.defineProperty(event, 'target', { value: editable });
    expect(resolveFeedbackKey(event, opts)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('is false for null and for ordinary elements', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
  });
});

describe('colorShortcutHints', () => {
  it('reports the keys the active scheme actually binds', () => {
    expect(colorShortcutHints('colors')).toEqual({ green: '1', yellow: '2', red: '3' });
    expect(colorShortcutHints('lightroom')).toEqual({
      red: '6', yellow: '7', green: '8', blue: '9',
    });
  });

  it('never claims a shortcut for purple — Lightroom has none either', () => {
    expect(colorShortcutHints('colors').purple).toBeUndefined();
    expect(colorShortcutHints('lightroom').purple).toBeUndefined();
  });
});
