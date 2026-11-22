import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ALBUM_LINK_GRACE_MS, GalleryWalkthroughHost, otherDialogOpen } from '../GalleryWalkthroughHost';
import type { GalleryWalkthroughState } from '../useGalleryWalkthrough';

const state = (autoOpen = vi.fn()): GalleryWalkthroughState => ({
  open: false, reopen: vi.fn(), close: vi.fn(), autoOpen, autoOpenPending: true, markShown: vi.fn(),
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('otherDialogOpen (issue 2551)', () => {
  it('counts shown modal dialogs, not the tour, hidden ones or a closed <dialog>', () => {
    expect(otherDialogOpen()).toBe(false);
    document.body.innerHTML = `
      <div data-walkthrough-root><div role="dialog" aria-modal="true"></div></div>
      <div hidden><div aria-modal="true"></div></div>
      <div role="dialog" style="display: none"></div>
      <dialog></dialog>`;
    expect(otherDialogOpen()).toBe(false);
    const open = document.createElement('div');
    open.setAttribute('role', 'alertdialog');
    document.body.appendChild(open);
    expect(otherDialogOpen()).toBe(true);
  });
});

describe('GalleryWalkthroughHost (issue 2551)', () => {
  it('stops waiting for an ?album= link that never opens its dialog', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?album=unknown');
    const autoOpen = vi.fn();
    render(<GalleryWalkthroughHost walkthrough={state(autoOpen)} ready albumLinkPending steps={[]} anchored />);
    expect(autoOpen).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(ALBUM_LINK_GRACE_MS); });
    expect(autoOpen).toHaveBeenCalledTimes(1);
  });

  it('does not wait for an album link the visitor did not arrive with', () => {
    const autoOpen = vi.fn();
    render(<GalleryWalkthroughHost walkthrough={state(autoOpen)} ready steps={[]} anchored />);
    expect(autoOpen).toHaveBeenCalledTimes(1);
  });
});
