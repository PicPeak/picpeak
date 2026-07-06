import { describe, expect, it, afterEach, vi } from 'vitest';
import { detectInAppBrowser } from '../inAppBrowser';

/**
 * Tests for the Instagram IAB detection helper (#654). The detector is the
 * gate that decides whether to surface the "open in browser" banner on the
 * gallery password page, so we pin a handful of representative real-world
 * UA strings here.
 */

function stubUserAgent(ua: string) {
  vi.stubGlobal('navigator', { userAgent: ua });
}

describe('detectInAppBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects Instagram on iOS', () => {
    stubUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 327.0.0.42.122',
    );
    expect(detectInAppBrowser()).toEqual({ app: 'instagram', platform: 'ios' });
  });

  it('detects Instagram on Android', () => {
    stubUserAgent(
      'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 327.0.0.42.122 Android (34/14; 480dpi; 1080x2208; samsung; SM-S921B; e1q; qcom; en_US; 565243795)',
    );
    expect(detectInAppBrowser()).toEqual({ app: 'instagram', platform: 'android' });
  });

  it('returns null for plain Safari on iPhone', () => {
    stubUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    );
    expect(detectInAppBrowser()).toEqual({ app: null, platform: 'ios' });
  });

  it('returns null for plain Chrome on Android', () => {
    stubUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
    );
    expect(detectInAppBrowser()).toEqual({ app: null, platform: 'android' });
  });

  it('returns null for desktop Chrome', () => {
    stubUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    expect(detectInAppBrowser()).toEqual({ app: null, platform: 'other' });
  });

  it('matches `Instagram` case-insensitively (defensive against UA quirks)', () => {
    stubUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 instagram 327.0.0',
    );
    expect(detectInAppBrowser().app).toBe('instagram');
  });

  it('does NOT match "Instagram" as a substring of an unrelated token', () => {
    // Word-boundary match prevents matching, e.g. "FooInstagrambar" — vanishingly
    // unlikely in real UAs but the regex should still be conservative.
    stubUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 myInstagramReader/1.0',
    );
    expect(detectInAppBrowser().app).toBe(null);
  });

  it('returns app:null when navigator is undefined (SSR safety)', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectInAppBrowser()).toEqual({ app: null, platform: 'other' });
  });
});
