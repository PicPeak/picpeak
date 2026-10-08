import { describe, it, expect } from 'vitest';
import { adminUploadErrorKey, imageLimitMessage, publicUploadErrorKey } from '../publicUploadErrors';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';

describe('public upload capacity messages', () => {
  it.each(['UPLOAD_REQUEST_TOO_LARGE', 'UPLOAD_LIFETIME_LIMIT', 'UPLOAD_PENDING_LIMIT', 'UPLOAD_CONCURRENCY_LIMIT',
    'UPLOAD_BYTE_RATE_LIMIT', 'UPLOAD_STORAGE_LOW', 'UPLOAD_QUOTA_UNAVAILABLE', 'UPLOAD_RESERVATION_LOST', 'UPLOAD_TIMEOUT', 'UPLOAD_TARGET_GONE', 'UPLOAD_REQUEST_TIMEOUT', 'UPLOAD_CLEANUP_UNAVAILABLE',
    'IMAGE_RESOURCE_LIMIT', 'IMAGE_QUEUE_FULL', 'IMAGE_TIMEOUT', 'IMAGE_CANCELLED', 'IMAGE_WORKER_UNAVAILABLE', 'IMAGE_WORKER_FAILED'])('localizes %s in both locales', code => {
    const key = publicUploadErrorKey(code)!;
    const name = key.split('.').pop()! as keyof typeof en.upload.capacity;
    expect(en.upload.capacity[name]).toBeTruthy(); expect(de.upload.capacity[name]).toBeTruthy();
  });
  it.each(['UPLOAD_REQUEST_TOO_LARGE', 'UPLOAD_PENDING_LIMIT', 'UPLOAD_CONCURRENCY_LIMIT', 'UPLOAD_STORAGE_LOW', 'UPLOAD_QUOTA_UNAVAILABLE',
    'UPLOAD_RESERVATION_LOST', 'UPLOAD_CLEANUP_UNAVAILABLE', 'UPLOAD_TIMEOUT', 'UPLOAD_REQUEST_TIMEOUT'])('gives a signed-in admin operator wording for %s in both locales', code => {
    const key = adminUploadErrorKey(code)!;
    expect(key).toMatch(/^upload\.adminCapacity\./);
    const name = key.split('.').pop()! as keyof typeof en.upload.adminCapacity;
    for (const text of [en.upload.adminCapacity[name], de.upload.adminCapacity[name]]) {
      expect(text).toBeTruthy(); expect(text).not.toMatch(/owner|Inhaber|Eigentümer/i);
    }
    expect(en.upload.adminCapacity.waiting).toContain('{{attempt}}'); expect(de.upload.adminCapacity.waiting).toContain('{{attempt}}');
  });
  it('falls back to the shared key for codes without admin wording, and to null for unrelated errors', () => {
    expect(adminUploadErrorKey('UPLOAD_TARGET_GONE')).toBe('upload.capacity.gone');
    expect(adminUploadErrorKey('PHOTO_CAP_REACHED')).toBeNull();
  });
  it.each([['pixels', 268.4], ['dimension', 65535], ['frames', 128], ['input', 96], ['decoded', 256], ['memory', 768]])(
    'names the %s limit a refused image exceeded, in both locales', (imageLimit, imageMax) => {
      for (const locale of [en, de]) {
        const t = (key: string, options?: Record<string, unknown>) => {
          const text = (locale.upload.capacity as Record<string, string>)[key.split('.').pop()!];
          expect(text).toContain('{{max}}');
          return text.replace('{{max}}', String(options?.max));
        };
        expect(imageLimitMessage(t, { code: 'IMAGE_RESOURCE_LIMIT', imageLimit, imageMax })).toContain(String(imageMax));
      }
    });
  it('falls back to the general image-limit text without a named limit, and ignores other errors', () => {
    const t = (key: string) => key;
    expect(imageLimitMessage(t, { code: 'IMAGE_RESOURCE_LIMIT' })).toBe('upload.capacity.decoded');
    expect(imageLimitMessage(t, { code: 'PHOTO_CAP_REACHED' })).toBeNull();
    expect(imageLimitMessage(t, undefined)).toBeNull();
    expect(en.upload.capacity.decoded).toBeTruthy(); expect(de.upload.capacity.decoded).toBeTruthy();
  });
  it('does not reclassify unrelated or unknown errors as capacity refusals', () => {
    expect(publicUploadErrorKey('PHOTO_CAP_REACHED')).toBeNull(); expect(publicUploadErrorKey('UPLOAD_UNKNOWN')).toBeNull();
    expect(publicUploadErrorKey(undefined)).toBeNull();
  });
});
