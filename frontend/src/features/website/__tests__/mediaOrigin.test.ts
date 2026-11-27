/**
 * Same-origin installs keep the real hero video in the preview (issue 2618);
 * only a split origin asks for the poster.
 */
import { expect, it } from 'vitest';
import { mediaOriginDiffers } from '../PreviewFrame';

it('treats a relative API (the default install) as the same origin', () => {
  expect(mediaOriginDiffers()).toBe(false);
});
