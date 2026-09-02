/**
 * A guest upload must show up in the grid on its own.
 *
 * Guest uploads are queued: `POST /gallery/:id/upload` answers 202 and the row
 * lands as `processing_status: 'pending'`, while `GET /gallery/:slug/photos`
 * only returns completed rows. The old handler refetched exactly once (via a
 * full `window.location.reload()`), which always raced the background worker —
 * the payload was still byte-identical, the browser was answered 304, and the
 * guest's photo silently vanished until they hard-reloaded (QA P4-E.01).
 *
 * GalleryView needs its providers, the router and a dozen child components to
 * render, so this pins the contract at source level (same approach as
 * facePreviewRendition.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'GalleryView.tsx'),
  'utf8'
);

describe('post-upload photo refresh', () => {
  it('never reloads the page to pick up an upload', () => {
    expect(source).not.toContain('window.location.reload');
  });

  it('keeps refetching until the queued photos appear', () => {
    const handler = source.slice(
      source.indexOf('const handleUploadComplete'),
      source.indexOf('// Get individual protection settings')
    );

    expect(handler).toContain('await refetch()');
    expect(handler).toMatch(/setInterval\(poll/);
    // Bounded: stop once the new photos land, and stop regardless after the
    // deadline so a failed background job can't leave a poll running forever.
    //
    // Waits for ALL queued files, not just the first. Each is processed
    // independently, so a `> baseline` comparison stops at photo 1 of N and
    // leaves the rest hidden until a manual refresh — the exact symptom this
    // polling exists to prevent.
    expect(handler).toContain('baseline + Math.max(1, queuedCount)');
    expect(handler).toContain('>= target');
    expect(handler).toContain('Date.now() > deadline');
  });

  it('wires the polling handler into the upload modals that render the grid', () => {
    const wired = source.match(/onUploadComplete=\{handleUploadComplete\}/g) || [];
    expect(wired.length).toBeGreaterThanOrEqual(2);
  });

  it('clears the poll when the gallery unmounts', () => {
    expect(source).toContain('useEffect(() => stopUploadRefresh, [])');
  });
});
