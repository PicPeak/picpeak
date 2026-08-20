/**
 * Face avatars must come from a whole-frame rendition.
 *
 * faceCropStyle positions a crop by scaling the ENTIRE frame and offsetting so
 * the face lands centre. That is only valid while the rendition shown is the
 * whole image at a uniform scale.
 *
 * Thumbnails are not. `thumbnail_fit` is seeded to 'cover' by migration
 * 040_add_thumbnail_settings, and generateThumbnail passes it straight to
 * sharp — so thumbnails are centre-cropped on essentially every install. The
 * DEFAULT_THUMBNAIL_FIT = 'inside' constant only applies when the setting row
 * is absent, and it never is.
 *
 * The result was that every face avatar — admin manager and the guest-facing
 * strip and sheet — was silently offset on any non-square photo, which reads
 * as a bad detector rather than a positioning bug. That is what made clusters
 * show a shoulder, the back of a head, or a patch of background.
 *
 * Previews use fit: 'inside', so they are the whole frame.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { facePreviewUrl, adminFacePreviewUrl, FACE_CROP_WIDTH } from '../imageTiers';

describe('face avatars use a whole-frame rendition', () => {
  const photo = { id: 42, preview_url: '/api/gallery/wed/preview/42' };

  it('never points a face crop at a thumbnail', () => {
    // The regression, stated directly: any URL containing /thumbnail/ is
    // cropped by fit:'cover' and will mis-place the face.
    expect(facePreviewUrl('wed', photo)).not.toContain('/thumbnail/');
    expect(adminFacePreviewUrl(7, 42)).not.toContain('/thumbnail/');
  });

  it('requests the small preview tier rather than the full 1920', () => {
    // A 64px avatar does not need 1920px, and the strip renders one per
    // person — pulling the full tier for each would be its own problem.
    expect(facePreviewUrl('wed', photo)).toBe(`/api/gallery/wed/preview/42?w=${FACE_CROP_WIDTH}`);
    expect(adminFacePreviewUrl(7, 42)).toBe(`/api/admin/photos/7/preview/42?w=${FACE_CROP_WIDTH}`);
  });

  it('prefers the served preview_url so a watermark query survives', () => {
    const wm = { id: 9, preview_url: '/api/gallery/wed/preview/9?wm=1' };
    expect(facePreviewUrl('wed', wm)).toBe(`/api/gallery/wed/preview/9?wm=1&w=${FACE_CROP_WIDTH}`);
  });

  it('still resolves when preview_url is absent', () => {
    // preview_url is only emitted when lightbox previews are enabled, but face
    // scanning calls ensurePreviewImage for everything it scans — so a preview
    // exists on disk for any photo that has a face, and the route can serve it.
    expect(facePreviewUrl('wed', { id: 5 }))
      .toBe(`/api/gallery/wed/preview/5?w=${FACE_CROP_WIDTH}`);
  });

  it('returns null rather than a wrong URL when it cannot build one', () => {
    // Callers fall back to thumbnail_url — still mis-positioned, but visible,
    // which beats a broken image.
    expect(facePreviewUrl(undefined, { id: 5 })).toBeNull();
    expect(facePreviewUrl('wed', null)).toBeNull();
    expect(facePreviewUrl('wed', undefined)).toBeNull();
  });

  it('sizes the tier from how much of the frame the face fills', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    const frame = { id: 1, width: 6000, height: 4000 };

    // A face across a hall: 200px in a 6000px frame is ~21px at the 640 tier,
    // which faceCropStyle then blows up ~9x. Indistinguishable from the
    // mis-positioning bug this whole change is about.
    expect(facePreviewUrl('wed', frame, { bbox: [0, 0, 200, 200] })).toContain('w=1920');

    // A close-up needs nothing like that.
    expect(facePreviewUrl('wed', frame, { bbox: [0, 0, 3000, 3000] })).toContain('w=640');
  });

  it('falls back to the fixed tier when the bbox is unknown', () => {
    expect(facePreviewUrl('wed', { id: 1, width: 6000, height: 4000 }, null))
      .toContain(`w=${FACE_CROP_WIDTH}`);
  });

  it('carries admin_preview so avatars do not 401 in preview mode', () => {
    // verifyGalleryAccess only accepts the admin cookie when admin_preview=1 is
    // on the request (middleware/gallery.js:28), and the preview flow mints no
    // gallery JWT — so without this every avatar breaks in exactly the mode an
    // admin uses to check a gallery before sending it.
    const orig = window.location.search;
    Object.defineProperty(window, 'location', {
      value: { search: '?admin_preview=1' }, configurable: true,
    });
    expect(facePreviewUrl('wed', { id: 5 })).toContain('admin_preview=1');
    Object.defineProperty(window, 'location', { value: { search: orig }, configurable: true });
  });

  // The helper being correct is not the contract — the call sites using it is.
  // Every assertion above passes with all three surfaces still reading
  // thumbnail_url, which is exactly the bug. So pin the call sites.
  describe('the three face surfaces actually use it', () => {
    const surfaces = [
      ['PeopleStrip', '../PeopleStrip.tsx', 'facePreviewUrl'],
      ['PeopleSheet', '../PeopleSheet.tsx', 'facePreviewUrl'],
      ['PeopleManagerModal', '../../admin/PeopleManagerModal.tsx', 'adminFacePreviewUrl'],
    ] as const;

    it.each(surfaces)('%s builds its avatar src from %s', (_name, rel, helper) => {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');

      // Matched inside the src={...} expression, not merely present in the
      // file: an import alone satisfies toContain(helper) while the avatar
      // still reads thumbnail_url, which is the bug wearing the fix's clothes.
      expect(src).toMatch(new RegExp(`src=\\{[^}]*${helper}\\(`));

      // And no face surface may reintroduce a hardcoded thumbnail path.
      expect(src).not.toContain('/thumbnail/${photoId}');
    });
  });
});
