import { beforeEach, expect, it } from 'vitest';
import { lockBodyScroll } from '../scrollLock';

beforeEach(() => {
  document.body.style.overflow = 'auto';
});

it('keeps the page locked until the last overlay closes, lightbox first', () => {
  const lightbox = lockBodyScroll();
  const dialog = lockBodyScroll();
  lightbox();
  expect(document.body.style.overflow).toBe('hidden');
  dialog();
  expect(document.body.style.overflow).toBe('auto');
});

it('restores the original overflow when the dialog closes first', () => {
  const lightbox = lockBodyScroll();
  const dialog = lockBodyScroll();
  dialog();
  expect(document.body.style.overflow).toBe('hidden');
  lightbox();
  expect(document.body.style.overflow).toBe('auto');
});

it('ignores a second release of the same lock', () => {
  const a = lockBodyScroll();
  const b = lockBodyScroll();
  a();
  a();
  expect(document.body.style.overflow).toBe('hidden');
  b();
  expect(document.body.style.overflow).toBe('auto');
});
