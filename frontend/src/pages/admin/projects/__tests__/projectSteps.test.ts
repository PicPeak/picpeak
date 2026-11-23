import { describe, expect, it } from 'vitest';
import type { ProjectOverview, ProjectStageKey } from '../../../../services/projects.service';
import { projectSteps, stepFor } from '../projectSteps';

const ALL_FLAGS = { quotes: true, contracts: true, bills: true, projects: true };
const everything = { flags: ALL_FLAGS, can: () => true };

function overview(current: ProjectStageKey | null, extra: Partial<ProjectOverview> = {}): ProjectOverview {
  const keys: ProjectStageKey[] = ['inquiry', 'quote', 'contract', 'gallery', 'invoice', 'done'];
  return {
    project: { id: 7, name: 'Hochzeit', customerAccountId: 3, customerEmail: 'k@example.com', status: 'active', createdAt: null, updatedAt: null },
    events: [], emails: [], quotes: [], contracts: [], invoices: [],
    hours: { entries: [], totalMinutes: 0 }, valuation: { byCurrency: [] },
    stage: { current, stages: keys.map((key) => ({ key, state: key === current ? 'current' : 'todo' })) },
    ...extra,
  } as ProjectOverview;
}

const quote = (id: number, status: string) => ({
  id, quote_number: `Q-${id}`, status, issue_date: null, valid_until: null, total_amount_minor: 1000, currency: 'CHF', deal_uuid: null,
});

describe('project steps', () => {
  it('opens a new quote prefilled from the project', () => {
    const step = stepFor('quote', overview('quote'), everything);
    expect(step?.kind).toBe('createQuote');
    expect(step?.href).toBe('/admin/clients/quotes/new?projectId=7&customerAccountId=3');
  });

  it('opens the quote still in progress instead of making a second one', () => {
    const step = stepFor('quote', overview('quote', { quotes: [quote(5, 'sent')] }), everything);
    expect(step).toMatchObject({ kind: 'openQuote', href: '/admin/clients/quotes/5' });
  });

  it('makes the contract from the accepted quote', () => {
    const step = stepFor('contract', overview('contract', { quotes: [quote(5, 'accepted')] }), everything);
    expect(step).toMatchObject({ kind: 'createContract', sourceId: 5 });
  });

  it('makes the gallery from the accepted quote when there is no contract', () => {
    const step = stepFor('gallery', overview('gallery', { quotes: [quote(5, 'accepted')] }), everything);
    expect(step).toMatchObject({ kind: 'convertQuoteToGallery', sourceId: 5 });
  });

  it('falls back to a new gallery when there is nothing to convert', () => {
    const step = stepFor('gallery', overview('gallery'), everything);
    expect(step?.kind).toBe('createGallery');
    expect(step?.href).toContain('/admin/events/new?projectId=7');
  });

  it('offers no new quote, contract or invoice on a project new documents cannot join, but still opens existing ones', () => {
    const base = overview('quote');
    const locked = (extra: Partial<ProjectOverview> = {}) => ({ ...base, ...extra, project: { ...base.project, documentsLinkable: false } });
    expect(stepFor('quote', locked(), everything)).toBeNull();
    expect(stepFor('contract', locked({ quotes: [quote(5, 'accepted')] }), everything)).toBeNull();
    expect(stepFor('invoice', locked(), everything)).toBeNull();
    expect(stepFor('quote', locked({ quotes: [quote(5, 'sent')] }), everything)?.kind).toBe('openQuote');
  });

  it('leaves out a step whose feature is off', () => {
    expect(stepFor('quote', overview('quote'), { flags: { ...ALL_FLAGS, quotes: false }, can: () => true })).toBeNull();
  });

  it('leaves out a conversion the admin lacks a permission for', () => {
    const can = (perm: string) => perm !== 'bills.manage';
    const step = stepFor('gallery', overview('gallery', { quotes: [quote(5, 'accepted')] }), { flags: ALL_FLAGS, can });
    // events.create alone still allows an empty gallery.
    expect(step?.kind).toBe('createGallery');
  });

  it('offers no invoice for a project without a customer', () => {
    const data = overview('invoice');
    data.project.customerAccountId = null;
    expect(stepFor('invoice', data, everything)).toBeNull();
  });

  it('does not offer a skipped stage as a jump', () => {
    const data = overview('quote');
    data.stage.stages = data.stage.stages.map((s) => (s.key === 'gallery' ? { ...s, state: 'skipped' } : s));
    expect(projectSteps(data, everything).later.map((s) => s.kind)).toEqual(['createInvoice']);
  });

  it('has no step on a closed project and lists only later creates as jumps', () => {
    expect(projectSteps(overview(null), everything)).toEqual({ main: null, later: [] });
    const { main, later } = projectSteps(overview('quote'), everything);
    expect(main?.kind).toBe('createQuote');
    expect(later.map((s) => s.kind)).toEqual(['createGallery', 'createInvoice']);
  });
});
