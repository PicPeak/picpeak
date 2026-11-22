import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GalleryWalkthrough, findWalkthroughAnchor } from '../GalleryWalkthrough';
import { buildWalkthroughSteps } from '../walkthroughSteps';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
      const o = (typeof fallback === 'object' ? fallback : opts) as Record<string, unknown> | undefined;
      return o && 'current' in o ? `${key}:${o.current}/${o.total}` : key;
    },
  }),
}));

const steps = buildWalkthroughSteps({
  scope: 'client', hasCategories: false, likes: false, favorites: false, downloads: true,
  people: false, selfie: false, uploads: false,
});

function mockDesktop(desktop: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('min-width') ? desktop : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const rect = (top: number, left: number, width: number, height: number) => ({
  top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}),
}) as DOMRect;

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('GalleryWalkthrough (issue 2551)', () => {
  it('is a dialog that walks forward and back by buttons and arrow keys', () => {
    mockDesktop(false);
    const onClose = vi.fn();
    render(<GalleryWalkthrough open steps={steps} anchored onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('gallery.walkthrough.stepOf:1/4')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('gallery.walkthrough.steps.browse.title');
    // Focus starts on the main button.
    expect(document.activeElement).toHaveTextContent('gallery.walkthrough.next');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('heading')).toHaveTextContent('gallery.walkthrough.steps.download.title');
    fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    expect(screen.getByRole('heading')).toHaveTextContent('gallery.walkthrough.steps.hide.title');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(screen.getByRole('heading')).toHaveTextContent('gallery.walkthrough.steps.download.title');
    fireEvent.click(screen.getByText('gallery.walkthrough.back'));
    expect(screen.getByRole('heading')).toHaveTextContent('gallery.walkthrough.steps.browse.title');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('finishes on the last step with "Got it"', () => {
    mockDesktop(false);
    const onClose = vi.fn();
    render(<GalleryWalkthrough open steps={steps} anchored onClose={onClose} />);
    for (let i = 0; i < steps.length - 1; i += 1) fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    expect(screen.queryByText('gallery.walkthrough.skip')).toBeNull();
    fireEvent.click(screen.getByText('gallery.walkthrough.done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('skips with Escape and with the Skip button', () => {
    mockDesktop(false);
    const onClose = vi.fn();
    render(<GalleryWalkthrough open steps={steps} anchored onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('gallery.walkthrough.skip'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('reports that it is on screen once per opening, never while closed', () => {
    mockDesktop(false);
    const onShown = vi.fn();
    const { rerender } = render(<GalleryWalkthrough open={false} steps={steps} anchored onClose={() => {}} onShown={onShown} />);
    expect(onShown).not.toHaveBeenCalled();
    rerender(<GalleryWalkthrough open steps={steps} anchored onClose={() => {}} onShown={onShown} />);
    fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(<GalleryWalkthrough open={false} steps={steps} anchored onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rings the real control on a desktop and centers the card without one', () => {
    mockDesktop(true);
    const button = document.createElement('button');
    button.setAttribute('data-tour', 'download-all');
    button.getBoundingClientRect = () => rect(100, 400, 120, 36);
    document.body.appendChild(button);

    render(<GalleryWalkthrough open steps={steps} anchored onClose={() => {}} />);
    // Step 1 (no categories) has no anchor: centered.
    expect(screen.queryByTestId('gallery-walkthrough-ring')).toBeNull();
    expect(screen.getByRole('dialog').style.transform).toContain('translate(-50%');

    fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    const ring = screen.getByTestId('gallery-walkthrough-ring');
    expect(ring.style.top).toBe('94px');
    expect(ring.style.left).toBe('394px');

    // The hide step's eye is not on the page: back to a centered card.
    fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    expect(screen.queryByTestId('gallery-walkthrough-ring')).toBeNull();
  });

  it('uses centered cards below md and where the layout asks for them', () => {
    const button = document.createElement('button');
    button.setAttribute('data-tour', 'download-all');
    button.getBoundingClientRect = () => rect(100, 400, 120, 36);
    document.body.appendChild(button);

    mockDesktop(false);
    const { unmount } = render(<GalleryWalkthrough open steps={steps} anchored onClose={() => {}} />);
    fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    expect(screen.queryByTestId('gallery-walkthrough-ring')).toBeNull();
    unmount();

    mockDesktop(true);
    render(<GalleryWalkthrough open steps={steps} anchored={false} onClose={() => {}} />);
    fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    expect(screen.queryByTestId('gallery-walkthrough-ring')).toBeNull();
  });

  it('scrolls an off-screen control into view', () => {
    mockDesktop(true);
    const button = document.createElement('button');
    button.setAttribute('data-tour', 'download-all');
    button.getBoundingClientRect = () => rect(window.innerHeight + 200, 10, 100, 30);
    const scrollIntoView = vi.fn();
    button.scrollIntoView = scrollIntoView;
    document.body.appendChild(button);
    render(<GalleryWalkthrough open steps={steps} anchored onClose={() => {}} />);
    act(() => { fireEvent.click(screen.getByText('gallery.walkthrough.next')); });
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
  });

  it('picks the first anchor that is on screen', () => {
    const hidden = document.createElement('button');
    hidden.setAttribute('data-tour', 'download-all');
    hidden.getBoundingClientRect = () => rect(0, 0, 0, 0);
    const shown = document.createElement('button');
    shown.setAttribute('data-tour', 'download-all');
    shown.getBoundingClientRect = () => rect(5, 5, 50, 20);
    document.body.append(hidden, shown);
    expect(findWalkthroughAnchor(['[data-tour="download-all"]'])).toBe(shown);
    expect(findWalkthroughAnchor(['[data-tour="missing"]'])).toBeNull();
  });
});
