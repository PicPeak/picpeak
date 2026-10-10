import { describe, it, expect } from 'vitest';
import { adminUploadErrorKey, publicUploadErrorKey } from '../publicUploadErrors';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';

describe('public upload capacity messages', () => {
  it.each(['UPLOAD_REQUEST_TOO_LARGE', 'UPLOAD_LIFETIME_LIMIT', 'UPLOAD_PENDING_LIMIT', 'UPLOAD_CONCURRENCY_LIMIT',
    'UPLOAD_BYTE_RATE_LIMIT', 'UPLOAD_STORAGE_LOW', 'UPLOAD_QUOTA_UNAVAILABLE', 'UPLOAD_RESERVATION_LOST', 'UPLOAD_TIMEOUT', 'UPLOAD_TARGET_GONE', 'UPLOAD_REQUEST_TIMEOUT', 'UPLOAD_CLEANUP_UNAVAILABLE'])('localizes %s in both locales', code => {
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
  it('does not reclassify unrelated or unknown errors as capacity refusals', () => {
    expect(publicUploadErrorKey('PHOTO_CAP_REACHED')).toBeNull(); expect(publicUploadErrorKey('UPLOAD_UNKNOWN')).toBeNull();
    expect(publicUploadErrorKey(undefined)).toBeNull();
  });
});
