/**
 * The "custom" analytics provider pastes admin-supplied HTML, scripts included,
 * into <head>. It ran on every route, the admin UI too, where those scripts
 * execute with the signed-in admin's privileges on the same origin. It now
 * never runs in a document that shows the admin UI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { analyticsService } from '../analytics.service';

const MARKER = 'data-custom-head-test';
const HTML = `<script ${MARKER}="1">window.__customHeadRan = true;</script>`;

function freshService() {
  // Module-level singleton with an `initialized` latch; each case needs its own.
  const service = new (analyticsService.constructor as new () => typeof analyticsService)();
  service.reloadPage = vi.fn();
  return service;
}

const injected = () => document.head.querySelectorAll(`script[${MARKER}]`).length;

describe('custom head HTML and the admin UI', () => {
  beforeEach(() => {
    document.head.querySelectorAll(`script[${MARKER}]`).forEach((node) => node.remove());
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('injects the HTML on a public route', () => {
    window.history.pushState({}, '', '/gallery/summer-party');
    const service = freshService();

    service.initialize({ provider: 'custom', customHeadHtml: HTML });

    expect(injected()).toBe(1);
  });

  it('does not inject the HTML when the visit starts in the admin UI', () => {
    window.history.pushState({}, '', '/admin/dashboard');
    const service = freshService();

    service.initialize({ provider: 'custom', customHeadHtml: HTML });

    expect(injected()).toBe(0);
  });

  it('runs the deferred HTML once a public route is shown', () => {
    window.history.pushState({}, '', '/admin/login');
    const service = freshService();
    service.initialize({ provider: 'custom', customHeadHtml: HTML });

    service.handleRouteChange('/gallery/summer-party');
    service.handleRouteChange('/gallery/summer-party/photo/3');

    expect(injected()).toBe(1);
    expect(service.reloadPage).not.toHaveBeenCalled();
  });

  it('reloads into a clean document when the admin UI is entered after the HTML ran', () => {
    window.history.pushState({}, '', '/');
    const service = freshService();
    service.initialize({ provider: 'custom', customHeadHtml: HTML });

    service.handleRouteChange('/admin');

    expect(service.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('leaves admin navigation alone when nothing was injected', () => {
    window.history.pushState({}, '', '/admin/dashboard');
    const service = freshService();
    service.initialize({ provider: 'custom', customHeadHtml: HTML });

    service.handleRouteChange('/admin/events');

    expect(service.reloadPage).not.toHaveBeenCalled();
    expect(injected()).toBe(0);
  });
});
