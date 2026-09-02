/**
 * DevTools protection must never break the gallery for a legitimate guest.
 *
 * The original implementation polled a `debugger;` trap, monkey-patched the
 * console and called `console.clear()` on every tick. With a debugger/CDP
 * client attached the page froze continuously, so every click, link and form
 * on the gallery died — a guest with DevTools open for any unrelated reason
 * got a silently unresponsive page (QA P4-A.06, reproduced on two events).
 *
 * These tests pin the shape of the deterrent: passive detection, no console
 * tampering, no `debugger`, and no document-wide interaction interception.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { useDevToolsProtection } from '../useDevToolsProtection';

// Comments explain the removed techniques by name, so strip them before
// asserting that the code itself no longer uses any of them.
const hookCode = fs
  .readFileSync(path.join(__dirname, '..', 'useDevToolsProtection.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('useDevToolsProtection', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addSpy = vi.spyOn(document, 'addEventListener');
    removeSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const documentEventTypes = () => addSpy.mock.calls.map((call) => call[0]);

  // React attaches its own delegated listeners to the render container, so
  // compare against a disabled render to isolate what the hook itself adds.
  const listenersAddedByHook = (options: Parameters<typeof useDevToolsProtection>[0]) => {
    renderHook(() => useDevToolsProtection({ ...options, enabled: false }));
    const baseline = new Set(documentEventTypes());
    addSpy.mockClear();
    renderHook(() => useDevToolsProtection(options));
    return documentEventTypes().filter((type) => !baseline.has(type));
  };

  it('never uses a debugger trap or clears the console', () => {
    expect(hookCode).not.toMatch(/(^|[^A-Za-z])debugger\s*;/);
    expect(hookCode).not.toContain('console.clear');
  });

  it('only listens for contextmenu and keydown on the document', () => {
    const added = listenersAddedByHook({ enabled: true, detectionSensitivity: 'medium' });

    expect(new Set(added)).toEqual(new Set(['contextmenu', 'keydown']));
  });

  it('does not intercept generic interaction events', () => {
    const added = listenersAddedByHook({ enabled: true, detectionSensitivity: 'high' });

    ['click', 'mousedown', 'mouseup', 'pointerdown', 'selectstart', 'dragstart', 'copy'].forEach(
      (type) => expect(added).not.toContain(type)
    );
  });

  it('leaves clicks on ordinary page elements working', () => {
    renderHook(() => useDevToolsProtection({ enabled: true }));

    const button = document.createElement('button');
    document.body.appendChild(button);
    const onClick = vi.fn();
    button.addEventListener('click', onClick);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    button.remove();
  });

  it('blocks right-click on images only, not on the rest of the page', () => {
    renderHook(() => useDevToolsProtection({ enabled: true }));

    const image = document.createElement('img');
    const paragraph = document.createElement('p');
    document.body.append(image, paragraph);

    const onImage = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    image.dispatchEvent(onImage);
    expect(onImage.defaultPrevented).toBe(true);

    const onText = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    paragraph.dispatchEvent(onText);
    expect(onText.defaultPrevented).toBe(false);

    image.remove();
    paragraph.remove();
  });

  it('does not replace or clear console methods while enabled', () => {
    const clearSpy = vi.spyOn(console, 'clear').mockImplementation(() => {});
    const originalLog = console.log;
    const originalWarn = console.warn;

    const { rerender } = renderHook(() => useDevToolsProtection({ enabled: true }));
    rerender();
    window.dispatchEvent(new Event('resize'));

    expect(clearSpy).not.toHaveBeenCalled();
    expect(console.log).toBe(originalLog);
    expect(console.warn).toBe(originalWarn);
  });

  it('registers nothing when disabled', () => {
    renderHook(() => useDevToolsProtection({ enabled: false }));

    expect(documentEventTypes()).not.toContain('contextmenu');
    expect(documentEventTypes()).not.toContain('keydown');
  });

  it('removes its listeners on unmount', () => {
    const { unmount } = renderHook(() => useDevToolsProtection({ enabled: true }));
    unmount();

    const removed = removeSpy.mock.calls.map((call) => call[0]);
    expect(removed).toContain('contextmenu');
    expect(removed).toContain('keydown');
  });

  it('reports detection once for a DevTools shortcut and blocks the key', () => {
    const onDevToolsDetected = vi.fn();
    renderHook(() => useDevToolsProtection({ enabled: true, onDevToolsDetected }));

    const first = new KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true });
    document.body.dispatchEvent(first);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true })
    );

    expect(first.defaultPrevented).toBe(true);
    expect(onDevToolsDetected).toHaveBeenCalledTimes(1);
  });

  describe('viewport heuristic', () => {
    const setWindowMetrics = (metrics: {
      innerHeight: number; outerHeight: number; innerWidth: number; outerWidth: number; dpr: number;
    }) => {
      for (const [key, value] of Object.entries({
        innerHeight: metrics.innerHeight,
        outerHeight: metrics.outerHeight,
        innerWidth: metrics.innerWidth,
        outerWidth: metrics.outerWidth,
        devicePixelRatio: metrics.dpr,
      })) {
        Object.defineProperty(window, key, { configurable: true, writable: true, value });
      }
    };

    it('does not fire on mount for a window that is merely zoomed', () => {
      // 200% zoom on a 1000px-tall window: innerHeight halves, outerHeight
      // does not, so the absolute gap is ~580px — far past every threshold.
      setWindowMetrics({ innerHeight: 500, outerHeight: 1080, innerWidth: 900, outerWidth: 1000, dpr: 2 });
      const onDevToolsDetected = vi.fn();
      renderHook(() => useDevToolsProtection({ enabled: true, onDevToolsDetected, detectionSensitivity: 'high' }));
      window.dispatchEvent(new Event('resize'));

      expect(onDevToolsDetected).not.toHaveBeenCalled();
    });

    it('does not fire when the gap grows because the guest zoomed in', () => {
      setWindowMetrics({ innerHeight: 900, outerHeight: 1000, innerWidth: 1000, outerWidth: 1000, dpr: 1 });
      const onDevToolsDetected = vi.fn();
      renderHook(() => useDevToolsProtection({ enabled: true, onDevToolsDetected, detectionSensitivity: 'high' }));

      setWindowMetrics({ innerHeight: 450, outerHeight: 1000, innerWidth: 500, outerWidth: 1000, dpr: 2 });
      window.dispatchEvent(new Event('resize'));

      expect(onDevToolsDetected).not.toHaveBeenCalled();
    });

    it('fires when the gap grows at a constant pixel ratio (a docked panel)', () => {
      setWindowMetrics({ innerHeight: 900, outerHeight: 1000, innerWidth: 1000, outerWidth: 1000, dpr: 1 });
      const onDevToolsDetected = vi.fn();
      renderHook(() => useDevToolsProtection({ enabled: true, onDevToolsDetected, detectionSensitivity: 'medium' }));

      setWindowMetrics({ innerHeight: 600, outerHeight: 1000, innerWidth: 1000, outerWidth: 1000, dpr: 1 });
      window.dispatchEvent(new Event('resize'));

      expect(onDevToolsDetected).toHaveBeenCalledTimes(1);
    });

    it('ignores a plain window resize, where outer and inner move together', () => {
      setWindowMetrics({ innerHeight: 900, outerHeight: 1000, innerWidth: 1000, outerWidth: 1000, dpr: 1 });
      const onDevToolsDetected = vi.fn();
      renderHook(() => useDevToolsProtection({ enabled: true, onDevToolsDetected, detectionSensitivity: 'high' }));

      setWindowMetrics({ innerHeight: 500, outerHeight: 600, innerWidth: 700, outerWidth: 700, dpr: 1 });
      window.dispatchEvent(new Event('resize'));

      expect(onDevToolsDetected).not.toHaveBeenCalled();
    });
  });

  it('lets ordinary keystrokes through', () => {
    renderHook(() => useDevToolsProtection({ enabled: true }));

    const typed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    document.body.dispatchEvent(typed);

    expect(typed.defaultPrevented).toBe(false);
  });
});
