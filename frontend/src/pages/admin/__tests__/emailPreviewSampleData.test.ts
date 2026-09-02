/**
 * The template Preview modal substituted a hand-maintained sample-data object
 * whose keys had drifted from the templates' declared `variables` (QA J.04):
 * {{host_name}}, {{gallery_password}} and {{expiry_date}} rendered as literal
 * tokens because the object still carried `password` / `expiration_date` and
 * no `host_name` at all. The payload is now derived from `variables`, so the
 * property that matters is coverage, not the contents of any one value.
 */
import { describe, it, expect } from 'vitest';

import { buildPreviewSampleData } from '../EmailConfigPage';

describe('buildPreviewSampleData', () => {
  const galleryCreatedVariables = [
    'host_name',
    'event_name',
    'event_date',
    'gallery_link',
    'gallery_password',
    'expiry_date',
  ];

  it('supplies a value for every variable the template declares', () => {
    const sample = buildPreviewSampleData(galleryCreatedVariables);

    expect(Object.keys(sample).sort()).toEqual([...galleryCreatedVariables].sort());
    for (const name of galleryCreatedVariables) {
      expect(sample[name]).toBeTruthy();
    }
  });

  it('never leaves a variable to render as a raw {{token}}', () => {
    const sample = buildPreviewSampleData(['customer_name', 'invoice_number', 'total_amount']);

    for (const value of Object.values(sample)) {
      expect(value).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('keeps date- and link-shaped variables looking like dates and links', () => {
    const sample = buildPreviewSampleData(galleryCreatedVariables);

    expect(sample.event_date).toMatch(/\d{4}/);
    expect(sample.expiry_date).toMatch(/\d{4}/);
    expect(sample.gallery_link).toMatch(/^https?:\/\//);
  });

  it('falls back to a readable stand-in for variables it does not know', () => {
    expect(buildPreviewSampleData(['storno_number'])).toEqual({ storno_number: '[storno_number]' });
  });

  it('handles a template with no declared variables', () => {
    expect(buildPreviewSampleData()).toEqual({});
    expect(buildPreviewSampleData([])).toEqual({});
  });
});
