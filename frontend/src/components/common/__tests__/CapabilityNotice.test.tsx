import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';

const info = vi.hoisted(() => vi.fn());
vi.mock('react-toastify', () => ({ toast: { info } }));

import { CapabilityNotice } from '../CapabilityNotice';
import { publicUploadErrorKey } from '../../../utils/publicUploadErrors';
import { isTransientUploadRefusal, stopsBatchAfterRetries } from '../../../utils/uploadCapacityRetry';

// The real locale files on a real i18next: a mocked lookup hid a key that never resolved.
const i18n = i18next.createInstance();
i18n.use(initReactI18next).init({
  lng: 'de',
  fallbackLng: 'en',
  resources: { en: { translation: en }, de: { translation: de } },
});

const raise = (detail: unknown) => window.dispatchEvent(new CustomEvent('picpeak:capability-unavailable', { detail }));
const mount = () => render(<I18nextProvider i18n={i18n}><CapabilityNotice /></I18nextProvider>);

describe('CapabilityNotice', () => {
  beforeEach(() => info.mockClear());
  afterEach(cleanup);

  it('tells the visitor a ZIP download is paused, in their language', () => {
    mount();
    raise('downloads.archive');
    expect(info).toHaveBeenCalledWith(de.capabilityNotice.archive, { toastId: 'capability-archive' });
  });

  it('leaves uploads to the upload screens, which show their own message', () => {
    mount();
    raise('uploads.new');
    raise(42);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('a paused upload', () => {
  it('waits and retries in the admin uploader', () => {
    expect(isTransientUploadRefusal('CAPABILITY_UNAVAILABLE')).toBe(true);
  });

  it('stops the batch once that wait is over, since a pause has no known end', () => {
    expect(stopsBatchAfterRetries('CAPABILITY_UNAVAILABLE')).toBe(true);
    expect(stopsBatchAfterRetries('UPLOAD_CONCURRENCY_LIMIT')).toBe(false);
  });

  it('has its own message in both shipped languages', () => {
    expect(publicUploadErrorKey('CAPABILITY_UNAVAILABLE')).toBe('upload.capacity.paused');
    expect(en.upload.capacity.paused).toBeTruthy();
    expect(de.upload.capacity.paused).toBeTruthy();
  });
});
