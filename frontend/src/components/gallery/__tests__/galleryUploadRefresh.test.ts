/**
 * A guest upload must show up in the grid on its own — and say so while it is
 * still being worked on.
 *
 * Guest uploads are queued: `POST /gallery/:id/upload` answers 202 and the row
 * lands as `processing_status: 'pending'`, while `GET /gallery/:slug/photos`
 * only returns completed rows. The old handler refetched exactly once (via a
 * full `window.location.reload()`), which always raced the background worker —
 * the payload was still byte-identical, the browser was answered 304, and the
 * guest's photo silently vanished until they hard-reloaded (QA P4-E.01).
 *
 * The follow-up (B7) replaced the blind count-baseline poll with one driven by
 * the real processing status of the guest's own upload group, so the UI can
 * show "processing…" and report a failure instead of timing out in silence.
 *
 * GalleryView needs its providers, the router and a dozen child components to
 * render, so this pins the contract at source level (same approach as
 * facePreviewRendition.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (...parts: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

const source = read('GalleryView.tsx');
const uploadSource = read('UserPhotoUpload.tsx');
const serviceSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'services', 'gallery.service.ts'),
  'utf8'
);

const handler = source.slice(
  source.indexOf('const handleUploadComplete'),
  source.indexOf('const uploadProcessingNotice')
);

describe('post-upload photo refresh', () => {
  it('never reloads the page to pick up an upload', () => {
    expect(source).not.toContain('window.location.reload');
  });

  it('drives the refresh off the upload group\'s processing status', () => {
    expect(handler).toContain('galleryService.getUploadStatus(slug, uploadIds)');
    // Refetch as photos land, not only once the whole batch settles.
    expect(handler).toContain('status.complete > lastComplete');
    expect(handler).toMatch(/setInterval\(poll/);
  });

  it('stops on the real terminal condition rather than a count baseline', () => {
    expect(handler).toContain('status.pending === 0 && status.processing === 0');
    // Still bounded, so a wedged worker can never leave a poll running forever.
    expect(handler).toContain('Date.now() > deadline');
  });

  it('tells the guest when a photo failed processing or is still queued', () => {
    expect(handler).toContain("toast.error(t('upload.processingFailed'");
    expect(handler).toContain("toast.info(t('upload.processingStillRunning')");
    // ...and renders a "processing…" notice while the poll runs.
    expect(source).toContain("t('upload.processing')");
    expect(source).toContain("t('upload.processingProgress'");
  });

  it('degrades to a plain refetch when the status call itself fails', () => {
    expect(handler).toContain('} catch {');
    expect(handler).toContain('await finish();');
  });

  it('wires the polling handler into the upload modals that render the grid', () => {
    const wired = source.match(/onUploadComplete=\{handleUploadComplete\}/g) || [];
    expect(wired.length).toBeGreaterThanOrEqual(2);
    // The notice is rendered next to each of them; the two layout branches
    // have no shared wrapper to hang it on.
    const shown = source.match(/\{uploadProcessingNotice\}/g) || [];
    expect(shown.length).toBe(wired.length);
  });

  it('clears the poll when the gallery unmounts', () => {
    expect(source).toContain('useEffect(() => stopUploadRefresh, [])');
  });
});

describe('upload id plumbing', () => {
  it('hands the 202 upload ids to the gallery', () => {
    expect(uploadSource).toContain('onUploadComplete: (uploadIds: string[]) => void');
    expect(uploadSource).toContain('uploadIds.push(response.data.upload_id)');
    expect(uploadSource).toContain('onUploadComplete(uploadIds)');
  });

  it('asks the gallery-scoped status route, batching the ids into one request', () => {
    expect(serviceSource).toContain('`/gallery/${slug}/uploads/status`');
    expect(serviceSource).toContain("params: { ids: uploadIds.join(',') }");
  });
});
