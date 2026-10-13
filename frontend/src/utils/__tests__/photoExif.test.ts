import { describe, expect, it } from 'vitest';
import { exifLine, exifParts, formatExposureTime } from '../photoExif';

describe('photoExif (issue 1733, D1)', () => {
  it('writes shutter speeds as photographers do', () => {
    expect(formatExposureTime(0.004)).toBe('1/250 s');
    expect(formatExposureTime(1 / 8000)).toBe('1/8000 s');
    expect(formatExposureTime(1 / 60)).toBe('1/60 s');
    expect(formatExposureTime(0.25)).toBe('1/4 s');
    expect(formatExposureTime(0.5)).toBe('0.5 s');
    expect(formatExposureTime(2)).toBe('2 s');
    expect(formatExposureTime(2.5)).toBe('2.5 s');
    expect(formatExposureTime(30)).toBe('30 s');
  });

  it('prints every part in order', () => {
    expect(exifLine({
      make: 'Canon', model: 'Canon EOS R5', lens: 'RF24-70mm F2.8 L IS USM',
      focal_length: 50, aperture: 2.8, exposure_time: 0.004, iso: 400,
    })).toBe('Canon EOS R5 · RF24-70mm F2.8 L IS USM · 50 mm · f/2.8 · 1/250 s · ISO 400');
  });

  it('does not repeat the brand, and adds it where the model lacks it', () => {
    expect(exifParts({ make: 'NIKON CORPORATION', model: 'NIKON Z 6' })).toEqual(['NIKON Z 6']);
    expect(exifParts({ make: 'FUJIFILM', model: 'X-T5' })).toEqual(['FUJIFILM X-T5']);
    expect(exifParts({ make: 'SONY' })).toEqual(['SONY']);
  });

  it('leaves out what is missing and trims the numbers', () => {
    expect(exifLine({ focal_length: 23.5, aperture: 8, iso: 3200 })).toBe('23.5 mm · f/8 · ISO 3200');
    expect(exifLine({ aperture: 0.95 })).toBe('f/0.95');
    expect(exifLine({})).toBeNull();
    expect(exifLine(null)).toBeNull();
    expect(exifLine(undefined)).toBeNull();
  });
});
