import { describe, it, expect } from 'vitest';
import { publicUploadErrorKey } from '../publicUploadErrors';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';

describe('public upload capacity messages', () => {
  it.each(['UPLOAD_REQUEST_TOO_LARGE', 'UPLOAD_LIFETIME_LIMIT', 'UPLOAD_PENDING_LIMIT', 'UPLOAD_CONCURRENCY_LIMIT',
    'UPLOAD_BYTE_RATE_LIMIT', 'UPLOAD_REQUEST_RATE_LIMIT', 'UPLOAD_STORAGE_LOW', 'UPLOAD_QUOTA_UNAVAILABLE', 'UPLOAD_RESERVATION_LOST', 'UPLOAD_TIMEOUT', 'UPLOAD_REQUEST_TIMEOUT', 'UPLOAD_CLEANUP_UNAVAILABLE'])('localizes %s in both locales', code => {
    const key = publicUploadErrorKey(code)!;
    const name = key.split('.').pop()! as keyof typeof en.upload.capacity;
    expect(en.upload.capacity[name]).toBeTruthy(); expect(de.upload.capacity[name]).toBeTruthy();
  });
  it('does not reclassify unrelated or unknown errors as capacity refusals', () => {
    expect(publicUploadErrorKey('PHOTO_CAP_REACHED')).toBeNull(); expect(publicUploadErrorKey('UPLOAD_UNKNOWN')).toBeNull();
    expect(publicUploadErrorKey(undefined)).toBeNull();
  });
});
