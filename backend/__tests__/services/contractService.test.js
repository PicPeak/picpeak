/**
 * Unit tests for the pure helpers in contractService (migration 130).
 *
 * The DB-bound CRUD paths (createContract / sendContract /
 * recordCustomerSignature / attachSignedPdfUpload) are exercised in
 * manual QA via the admin + public routes. This file covers the
 * deterministic helpers so regressions in placeholder substitution or
 * section ordering surface before they leak into a rendered contract.
 *
 * The service pulls in DB-bound peers (businessProfileService,
 * pdfService, emailProcessor) at the top level. We stub the DB layer
 * + the side-effect peers so the require chain doesn't try to connect
 * to anything; the helpers under test are pure.
 */

const path = require('path');
const servicePath = path.join(__dirname, '..', '..', 'src', 'services', 'contractService');

jest.mock('../../src/database/db', () => ({
  db: jest.fn(),
  logActivity: jest.fn(),
  withRetry: (fn) => fn(),
}));
jest.mock('../../src/services/businessProfileService', () => ({
  getProfile: jest.fn(),
}));
jest.mock('../../src/services/pdfService', () => ({
  renderContractToBuffer: jest.fn(),
}));
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(),
}));
jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: jest.fn(),
}));
jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: jest.fn(),
}));

const { _internal } = require(servicePath);
const { renderTemplatedBody, SECTIONS_ORDER } = _internal;

describe('renderTemplatedBody', () => {
  it('substitutes simple {{var}} placeholders', () => {
    expect(renderTemplatedBody(
      'Hello {{name}}, due in {{net_days}} days.',
      { name: 'Alice', net_days: 30 },
    )).toBe('Hello Alice, due in 30 days.');
  });

  it('preserves unknown placeholders literally so admins notice missing fields', () => {
    expect(renderTemplatedBody(
      'Bill from {{issuer}} to {{customer_name}}',
      { issuer: 'PicPeak GmbH' },
    )).toBe('Bill from PicPeak GmbH to {{customer_name}}');
  });

  it('keeps {{#if var}}…{{/if}} block when var is truthy', () => {
    expect(renderTemplatedBody(
      '{{#if has_skonto}}Skonto: {{pct}} %{{/if}} on early payment',
      { has_skonto: true, pct: 2 },
    )).toBe('Skonto: 2 % on early payment');
  });

  it('drops {{#if var}}…{{/if}} block when var is falsy', () => {
    expect(renderTemplatedBody(
      'Net {{net_days}} d{{#if has_skonto}}, Skonto {{pct}}%{{/if}}.',
      { net_days: 30, has_skonto: false, pct: 2 },
    )).toBe('Net 30 d.');
  });

  it('treats missing variables in {{#if}} as falsy', () => {
    expect(renderTemplatedBody(
      'A{{#if missing}}B{{/if}}C',
      { unrelated: 'foo' },
    )).toBe('AC');
  });

  it('handles empty strings and missing variables map gracefully', () => {
    expect(renderTemplatedBody('', { x: 1 })).toBe('');
    expect(renderTemplatedBody('plain text', null)).toBe('plain text');
    expect(renderTemplatedBody('plain text', undefined)).toBe('plain text');
  });

  it('passes through non-string input unchanged', () => {
    expect(renderTemplatedBody(null, { x: 1 })).toBeNull();
    expect(renderTemplatedBody(undefined, { x: 1 })).toBeUndefined();
  });

  it('substitutes numeric and falsy variable values as strings', () => {
    expect(renderTemplatedBody('count: {{n}}', { n: 0 })).toBe('count: 0');
    expect(renderTemplatedBody('flag: {{flag}}', { flag: false })).toBe('flag: false');
  });
});

describe('SECTIONS_ORDER', () => {
  it('matches the canonical six-section order locked in the spec', () => {
    expect(SECTIONS_ORDER).toEqual([
      'basics', 'scope', 'privacy', 'commercial', 'nda', 'closing',
    ]);
  });

  it('stays in sync with contractBlocksService.ALLOWED_SECTIONS', () => {
    const blocksService = require('../../src/services/contractBlocksService');
    expect([...SECTIONS_ORDER].sort()).toEqual(
      [...blocksService.ALLOWED_SECTIONS].sort(),
    );
  });
});
