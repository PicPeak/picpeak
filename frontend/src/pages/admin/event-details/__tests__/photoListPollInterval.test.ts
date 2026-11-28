import { describe, expect, it } from 'vitest';
import { photoListPollInterval } from '../utils';

describe('photoListPollInterval', () => {
  it('polls while uploads process and while saved edits are being applied (issue 2619)', () => {
    expect(photoListPollInterval(undefined)).toBe(false);
    expect(photoListPollInterval([{ processing_status: 'complete' }])).toBe(false);
    expect(photoListPollInterval([{ processing_status: 'processing' }])).toBe(2000);
    expect(photoListPollInterval([{ processing_status: 'complete', edit_rev: 2, edit_applied_rev: 1 }])).toBe(2000);
    expect(photoListPollInterval([{ processing_status: 'complete', edit_rev: 2, edit_applied_rev: 2 }])).toBe(false);
  });

  it('stops for an edit whose render failed: it waits for a retry', () => {
    expect(photoListPollInterval([{ processing_status: 'complete', edit_rev: 2, edit_applied_rev: 1, edit_failed: true }])).toBe(false);
  });
});
