/**
 * Mobile tap determinism (#1263).
 *
 * The overlay actions (open / download / like) are hidden with `opacity-0`,
 * which hides pixels but not hit-testing. On a pointer device hover reveals
 * them before anyone can click, so the gap never shows; on a touchscreen there
 * is no hover, so the buttons stayed permanently invisible AND permanently
 * tappable. A tap near the middle of a tile hit an unseen button, whose
 * stopPropagation then suppressed the tile's own open — so the same gesture
 * downloaded, liked or opened depending on where the finger landed.
 *
 * Visibility and hit-testing have to move together. These tests pin the
 * pointer-events half, which is the half that was missing.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { PhotoCard } from '../PhotoCard';
import { __inputModeTesting } from '../../../hooks/useInputMode';
import type { Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="tile" src={src} alt={alt} />
  ),
}));

vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

const PHOTO = {
  id: 7,
  filename: 'IMG_0001.jpg',
  url: '/api/gallery/x/photo/7',
  thumbnail_url: '/api/gallery/x/thumbnail/7',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
} as Photo;

/** Report a coarse, hover-less pointer — a phone. */
function stubTouchDevice(isTouch: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: isTouch && query.includes('pointer: coarse'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    value: isTouch ? 5 : 0,
  });
  // jsdom defines `ontouchstart`, which PhotoCard reads as a third touch
  // signal — remove it so the pointer-device case is actually exercised.
  if (isTouch) (window as any).ontouchstart = null;
  else delete (window as any).ontouchstart;
  // The input mode is a module-level store now (#1275), so it has to re-read
  // the stubbed device rather than keep what it decided on first import.
  __inputModeTesting.reset();
}

/**
 * Dispatch a real pointer event, the way a finger or a mouse announces itself.
 *
 * Wrapped in act() because the store notifies outside React's own event
 * system: without it the re-render has not landed by the time the following
 * click is dispatched, which is precisely the ordering the fix depends on.
 */
function pointer(type: 'pointerdown' | 'pointermove', pointerType: string) {
  act(() => {
    const event = new Event(type, { bubbles: true }) as any;
    event.pointerType = pointerType;
    window.dispatchEvent(event);
  });
}

/** Class tokens, so `md:group-hover:pointer-events-auto` isn't mistaken for the bare one. */
function tokens(el: HTMLElement) {
  return Array.from(el.classList);
}

function renderCard(props: Partial<React.ComponentProps<typeof PhotoCard>> = {}) {
  return render(
    <PhotoCard
      photo={PHOTO}
      isSelected={false}
      isSelectionMode={false}
      onClick={() => {}}
      onDownload={() => {}}
      onToggleSelect={() => {}}
      className="group tile"
      overlayBaseClassName="absolute inset-0 flex items-center justify-center gap-2"
      imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
      allowDownloads
      {...props}
    />,
  );
}

/** The overlay is the element the action buttons live in. */
function overlayOf(container: HTMLElement) {
  const button = container.querySelector('[aria-label="View full size"]');
  return button?.parentElement as HTMLElement;
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return 320; },
  });
  stubTouchDevice(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as any).offsetWidth;
});

describe('PhotoCard overlay hit-testing (#1263)', () => {
  it('makes the hidden overlay inert, so a tap cannot reach an unseen button', () => {
    const { container } = renderCard();
    const overlay = overlayOf(container);

    expect(tokens(overlay)).toContain('opacity-0');
    expect(tokens(overlay)).toContain('pointer-events-none');
    expect(tokens(overlay)).not.toContain('pointer-events-auto');
  });

  it('arms the overlay once a tap has revealed it', () => {
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });

    // First tap on the tile body reveals the actions; it must not open.
    fireEvent.click(container.querySelector('.tile')!);
    expect(onClick).not.toHaveBeenCalled();

    const overlay = overlayOf(container);
    expect(tokens(overlay)).toContain('opacity-100');
    expect(tokens(overlay)).toContain('pointer-events-auto');
    expect(tokens(overlay)).not.toContain('pointer-events-none');

    // Second tap on the tile body now opens the photo.
    fireEvent.click(container.querySelector('.tile')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the selection checkbox inert while it is invisible', () => {
    const onToggleSelect = vi.fn();
    const { container } = renderCard({ onToggleSelect });
    const checkbox = screen.getByRole('checkbox');

    expect(tokens(checkbox)).toContain('opacity-0');
    expect(tokens(checkbox)).toContain('pointer-events-none');

    fireEvent.click(container.querySelector('.tile')!);
    expect(tokens(screen.getByRole('checkbox'))).toContain('pointer-events-auto');
  });

  it('reveals on touch without a layout having to opt in', () => {
    // Masonry / Mosaic / Timeline previously passed their own
    // `opacity-0 group-hover:opacity-100` and never opted into the touch
    // state machine, so on a phone their overlay was unreachable-but-tappable
    // forever. PhotoCard owns visibility for every layout now.
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });
    fireEvent.click(container.querySelector('.tile')!);
    expect(onClick).not.toHaveBeenCalled();
    expect(tokens(overlayOf(container))).toContain('pointer-events-auto');
  });

  it('leaves a pointer device on hover semantics — no tap-to-reveal step', () => {
    stubTouchDevice(false);
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });

    fireEvent.click(container.querySelector('.tile')!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(tokens(overlayOf(container))).toContain('group-hover:pointer-events-auto');
  });

  it('reaches the hover overlay below the md breakpoint', () => {
    // Codex review round 1. The hover variants used to be `md:group-hover:*`,
    // so a mouse user with a window under 768px saw no overlay at all — and in
    // Masonry, Mosaic and Timeline, whose `group-hover:` was unprefixed before
    // this branch, that made download and like unreachable. Viewport width is
    // not what decides whether a device can hover.
    stubTouchDevice(false);
    const { container } = renderCard();
    const overlay = tokens(overlayOf(container));

    expect(overlay).toContain('group-hover:opacity-100');
    expect(overlay).toContain('group-hover:pointer-events-auto');
    expect(overlay.some((c) => c.startsWith('md:'))).toBe(false);
  });

  it('withholds the hover variants on touch, where :hover latches after a tap', () => {
    // The reason the breakpoint was there in the first place. Emitting
    // `group-hover:` on a touchscreen leaves the overlay stuck open on the
    // last tile tapped.
    const { container } = renderCard();
    expect(tokens(overlayOf(container)).some((c) => c.startsWith('group-hover:'))).toBe(false);
  });

  it('switches to tap-to-reveal when a finger arrives on a mouse-primary device', () => {
    // #1275. A touchscreen laptop reports a fine primary pointer, so before
    // this the finger was handled as a click: the photo opened with no reveal
    // step and the tile's own actions needed a hover a finger cannot produce.
    stubTouchDevice(false);
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });
    const tile = () => container.querySelector('.tile')!;

    // Mouse first — one click opens, as it should on this device.
    fireEvent.click(tile());
    expect(onClick).toHaveBeenCalledTimes(1);

    // Now a finger. The tap announces itself before the click lands.
    pointer('pointerdown', 'touch');
    fireEvent.click(tile());
    expect(onClick).toHaveBeenCalledTimes(1); // revealed, did not open
    expect(tokens(overlayOf(container))).toContain('pointer-events-auto');
  });

  it('switches back to one-click open when the mouse returns', () => {
    // The other direction, on the same device in the same session: an iPad
    // with a trackpad reports a coarse primary pointer, so a mouse click was
    // being handled as a tap and opening a photo took two of them.
    stubTouchDevice(true);
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });
    const tile = () => container.querySelector('.tile')!;

    // Finger: reveal, then open.
    pointer('pointerdown', 'touch');
    fireEvent.click(tile());
    expect(onClick).not.toHaveBeenCalled();

    // A mouse approaching is enough — the mode must be right BEFORE the click.
    pointer('pointermove', 'mouse');
    fireEvent.click(tile());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(tokens(overlayOf(container))).toContain('group-hover:opacity-100');
  });

  it('keeps hidden controls inert in every mode', () => {
    // The #1263 guarantee has to survive the mode switching: whichever input
    // is in use, a control that cannot be seen cannot be hit.
    stubTouchDevice(false);
    const { container } = renderCard();
    expect(tokens(overlayOf(container))).toContain('pointer-events-none');

    pointer('pointerdown', 'touch');
    expect(tokens(overlayOf(container))).toContain('pointer-events-none');

    pointer('pointermove', 'mouse');
    expect(tokens(overlayOf(container))).toContain('pointer-events-none');
  });

  it('treats a pen like a finger, since it taps rather than hovers', () => {
    stubTouchDevice(false);
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });

    pointer('pointerdown', 'pen');
    fireEvent.click(container.querySelector('.tile')!);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('treats a touchscreen laptop driven by a mouse as a pointer device', () => {
    // Codex review round 1. matchMedia describes the PRIMARY pointer;
    // maxTouchPoints only says a touchscreen exists. OR-ing them classified a
    // hybrid device as touch-only, so an ordinary click merely revealed the
    // overlay and opening a photo took two clicks — a regression for the three
    // layouts that had no tap-to-reveal step before.
    stubTouchDevice(false);
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 10 });
    (window as any).ontouchstart = null;

    const onClick = vi.fn();
    const { container } = renderCard({ onClick });

    fireEvent.click(container.querySelector('.tile')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
