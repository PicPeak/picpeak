/**
 * Admin → quote catalogue + templates (#1451). Hits /api/admin/quote-catalog/*.
 * The service items themselves stay on quotesService (…/quotes/presets/line-items).
 */
import { api } from '../config/api';
import type { BoundTo, LineUnit, PriceMode } from '../utils/lineItemTotals';

export interface QuotePackageItem {
  id?: number;
  presetId: number;
  presetName?: string;
  detailsText?: string | null;
  /** null = the catalogue item's default quantity. */
  quantity: number | null;
  boundTo?: BoundTo | null;
  position?: number;
  unitPriceMinor?: number;
  unit?: LineUnit | null;
  priceMode?: PriceMode;
  pinnedRateMinor?: number | null;
  quantityDefault?: number;
  presetIsActive?: boolean;
}

export interface QuotePackage {
  id: number;
  name: string;
  description: string | null;
  currency: string;
  displayOrder: number;
  isActive: boolean;
  items: QuotePackageItem[];
}

export interface QuotePromotion {
  id: number;
  name: string;
  description: string | null;
  type: 'percent' | 'fixed';
  valueMinor: number | null;
  currency: string | null;
  percent: number | null;
  validFrom: string | null;
  validUntil: string | null;
  displayOrder: number;
  isActive: boolean;
}

// ---- pricing factors (#2440) ------------------------------------------

export type FactorInputType = 'number' | 'toggle' | 'choice' | 'zone';
/** number: per_unit | step; toggle: fixed | percent; choice / zone: per option. */
export type FactorEffect = 'per_unit' | 'step' | 'fixed' | 'percent';

export interface PricingFactorOption {
  id?: number;
  label: string;
  effect: 'fixed' | 'percent';
  amountMinor: number | null;
  percent: number | null;
  /** Zone only: one entry per line — "8001", "80*" (prefix), "8000-8099" (range). */
  postcodes?: string | null;
  position?: number;
}

export interface PricingFactor {
  id: number;
  name: string;
  description: string | null;
  inputType: FactorInputType;
  effect: FactorEffect | null;
  unitLabel: string | null;
  currency: string;
  amountMinor: number | null;
  percent: number | null;
  includedUnits: number | null;
  stepSize: number | null;
  minValue: number | null;
  maxValue: number | null;
  /** number: the value; toggle: "true"; choice / zone: an option id. */
  defaultValue: string | null;
  /** Shown on the public booking request; otherwise its default is used there. */
  clientVisible: boolean;
  displayOrder: number;
  isActive: boolean;
  options: PricingFactorOption[];
}

/** number | boolean | option id | { optionId } | { postcode } */
export type FactorValue = number | boolean | null | { optionId?: number; postcode?: string };

export interface FactorPriceLine {
  kind: 'base' | 'factor';
  factorId: number | null;
  description: string;
  quantity: number;
  unit: LineUnit | null;
  unitPriceMinor: number;
  totalMinor: number;
  priceMode: PriceMode | null;
  rateSource: 'item' | 'customer' | 'default' | null;
}

/** Stored on the parent quote line; explains the price, never sets it. */
export interface PricingFactorsSnapshot {
  version: number;
  presetId: number;
  presetName: string;
  currency: string;
  quantity: number;
  values: Record<string, FactorValue>;
  factors: Array<{ id: number; name: string; inputType: FactorInputType }>;
  unmatched: number[];
  /** The lines this pricing made; re-pricing replaces only unchanged ones. */
  lines?: Array<{ description: string; quantity: number; unitPriceMinor: number }>;
}

export interface FactorPriceResult {
  currency: string;
  baseMinor: number;
  totalMinor: number;
  lines: FactorPriceLine[];
  /** Zone factors whose postcode is in no zone. */
  unmatched: number[];
  snapshot: PricingFactorsSnapshot;
}

export type TextBlockKind = 'intro' | 'scope' | 'note' | 'closing' | 'terms';

export interface QuoteTextBlock {
  id: number;
  kind: TextBlockKind;
  language: string;
  name: string;
  body: string;
  displayOrder: number;
  isActive: boolean;
}

export interface TemplateLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountPercent: number;
  unit: LineUnit | null;
  priceMode: 'hour' | 'day' | null;
  boundTo: BoundTo | null;
  rateSource: 'auto' | 'item' | 'manual' | null;
  detailsText: string | null;
}

export type TemplateSection =
  | { type: 'item'; presetId: number; quantity: number | null; boundTo: BoundTo | null; isOptional: boolean }
  | { type: 'package'; packageId: number; isOptional: boolean }
  | { type: 'line'; line: TemplateLine; children: TemplateLine[]; isOptional: boolean };

export interface TemplateDraft {
  sections: TemplateSection[];
  introTextBlockId: number | null;
  introText: string | null;
  outroTextBlockId: number | null;
  outroText: string | null;
  promotionIds: number[];
  hours: number | null;
  days: number | null;
  validityDays: number | null;
  paymentNetDaysTemplateId: number | null;
  paymentTimingTemplateId: number | null;
  bookingWorkflowId: number | null;
  vatRate: number | null;
  vatCode: string | null;
}

export interface QuoteTemplate {
  id: number;
  name: string;
  description: string | null;
  eventType: string | null;
  language: string | null;
  currency: string | null;
  status: 'draft' | 'published' | 'archived';
  currentVersion: number | null;
  /** The contract template a contract from such a quote starts from; null = the default. */
  defaultContractTemplateId?: number | null;
  draft: TemplateDraft;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteTemplateVersion {
  id: number;
  version: number;
  publishedAt: string;
  publishedByAdminId: number | null;
}

export interface TemplateResponse {
  template: QuoteTemplate;
  versions: QuoteTemplateVersion[];
}

export interface TemplateSavePayload {
  name?: string;
  description?: string | null;
  eventType?: string | null;
  language?: string | null;
  currency?: string | null;
  defaultContractTemplateId?: number | null;
  draft?: TemplateDraft;
}

const unwrap = <T,>(data: { data?: T } & T): T => (data.data || data) as T;

export const quoteCatalogService = {
  // ---- packages -------------------------------------------------------
  async listPackages(opts: { activeOnly?: boolean } = {}): Promise<QuotePackage[]> {
    const { data } = await api.get('/admin/quote-catalog/packages', { params: opts.activeOnly ? { activeOnly: 'true' } : undefined });
    return unwrap<{ packages: QuotePackage[] }>(data).packages;
  },
  async createPackage(payload: Partial<QuotePackage> & { name: string }): Promise<QuotePackage> {
    const { data } = await api.post('/admin/quote-catalog/packages', payload);
    return unwrap<{ package: QuotePackage }>(data).package;
  },
  async updatePackage(id: number, payload: Partial<QuotePackage>): Promise<QuotePackage> {
    const { data } = await api.put(`/admin/quote-catalog/packages/${id}`, payload);
    return unwrap<{ package: QuotePackage }>(data).package;
  },
  async archivePackage(id: number): Promise<void> {
    await api.delete(`/admin/quote-catalog/packages/${id}`);
  },

  // ---- pricing factors (#2440) ----------------------------------------
  async listFactors(opts: { activeOnly?: boolean } = {}): Promise<PricingFactor[]> {
    const { data } = await api.get('/admin/quote-catalog/factors', { params: opts.activeOnly ? { activeOnly: 'true' } : undefined });
    return unwrap<{ factors: PricingFactor[] }>(data).factors;
  },
  async createFactor(payload: Partial<PricingFactor> & { name: string; inputType: FactorInputType }): Promise<PricingFactor> {
    const { data } = await api.post('/admin/quote-catalog/factors', payload);
    return unwrap<{ factor: PricingFactor }>(data).factor;
  },
  async updateFactor(id: number, payload: Partial<PricingFactor>): Promise<PricingFactor> {
    const { data } = await api.put(`/admin/quote-catalog/factors/${id}`, payload);
    return unwrap<{ factor: PricingFactor }>(data).factor;
  },
  async archiveFactor(id: number): Promise<void> {
    await api.delete(`/admin/quote-catalog/factors/${id}`);
  },
  async priceWithFactors(payload: {
    presetId: number; values: Record<string, FactorValue>; customerId?: number | null; quantity?: number | null; language?: string;
  }): Promise<FactorPriceResult> {
    const { data } = await api.post('/admin/quote-catalog/factors/price', payload);
    return unwrap<FactorPriceResult>(data);
  },

  // ---- promotions -----------------------------------------------------
  async listPromotions(opts: { activeOnly?: boolean } = {}): Promise<QuotePromotion[]> {
    const { data } = await api.get('/admin/quote-catalog/promotions', { params: opts.activeOnly ? { activeOnly: 'true' } : undefined });
    return unwrap<{ promotions: QuotePromotion[] }>(data).promotions;
  },
  async createPromotion(payload: Partial<QuotePromotion> & { name: string; type: QuotePromotion['type'] }): Promise<QuotePromotion> {
    const { data } = await api.post('/admin/quote-catalog/promotions', payload);
    return unwrap<{ promotion: QuotePromotion }>(data).promotion;
  },
  async updatePromotion(id: number, payload: Partial<QuotePromotion>): Promise<QuotePromotion> {
    const { data } = await api.put(`/admin/quote-catalog/promotions/${id}`, payload);
    return unwrap<{ promotion: QuotePromotion }>(data).promotion;
  },
  async archivePromotion(id: number): Promise<void> {
    await api.delete(`/admin/quote-catalog/promotions/${id}`);
  },

  // ---- text blocks ----------------------------------------------------
  async listTextBlocks(opts: { activeOnly?: boolean; kind?: TextBlockKind } = {}): Promise<QuoteTextBlock[]> {
    const params: Record<string, string> = {};
    if (opts.activeOnly) params.activeOnly = 'true';
    if (opts.kind) params.kind = opts.kind;
    const { data } = await api.get('/admin/quote-catalog/text-blocks', { params });
    return unwrap<{ textBlocks: QuoteTextBlock[] }>(data).textBlocks;
  },
  async createTextBlock(payload: Partial<QuoteTextBlock> & { kind: TextBlockKind; name: string; body: string }): Promise<QuoteTextBlock> {
    const { data } = await api.post('/admin/quote-catalog/text-blocks', payload);
    return unwrap<{ textBlock: QuoteTextBlock }>(data).textBlock;
  },
  async updateTextBlock(id: number, payload: Partial<QuoteTextBlock>): Promise<QuoteTextBlock> {
    const { data } = await api.put(`/admin/quote-catalog/text-blocks/${id}`, payload);
    return unwrap<{ textBlock: QuoteTextBlock }>(data).textBlock;
  },
  async archiveTextBlock(id: number): Promise<void> {
    await api.delete(`/admin/quote-catalog/text-blocks/${id}`);
  },

  // ---- templates ------------------------------------------------------
  async listTemplates(opts: { publishedOnly?: boolean } = {}): Promise<QuoteTemplate[]> {
    const { data } = await api.get('/admin/quote-catalog/templates', { params: opts.publishedOnly ? { publishedOnly: 'true' } : undefined });
    return unwrap<{ templates: QuoteTemplate[] }>(data).templates;
  },
  async getTemplate(id: number): Promise<TemplateResponse> {
    const { data } = await api.get(`/admin/quote-catalog/templates/${id}`);
    return unwrap<TemplateResponse>(data);
  },
  async createTemplate(payload: TemplateSavePayload & { name: string }): Promise<TemplateResponse> {
    const { data } = await api.post('/admin/quote-catalog/templates', payload);
    return unwrap<TemplateResponse>(data);
  },
  async updateTemplate(id: number, payload: TemplateSavePayload): Promise<TemplateResponse> {
    const { data } = await api.put(`/admin/quote-catalog/templates/${id}`, payload);
    return unwrap<TemplateResponse>(data);
  },
  async archiveTemplate(id: number): Promise<void> {
    await api.delete(`/admin/quote-catalog/templates/${id}`);
  },
  async publishTemplate(id: number): Promise<TemplateResponse & { version: number }> {
    const { data } = await api.post(`/admin/quote-catalog/templates/${id}/publish`);
    return unwrap<TemplateResponse & { version: number }>(data);
  },
  /** Creates a draft quote from the latest published version. */
  async createQuoteFromTemplate(id: number, payload: {
    customerAccountId: number; eventName?: string; eventDate?: string; hours?: number | null; days?: number | null; version?: number;
  }): Promise<{ quoteId: number; version: number; skippedPromotions: string[] }> {
    const { data } = await api.post(`/admin/quote-catalog/templates/${id}/quotes`, payload);
    return unwrap<{ quoteId: number; version: number; skippedPromotions: string[] }>(data);
  },
  async saveQuoteAsTemplate(quoteId: number, name: string): Promise<TemplateResponse> {
    const { data } = await api.post(`/admin/quote-catalog/templates/from-quote/${quoteId}`, { name });
    return unwrap<TemplateResponse>(data);
  },
};
