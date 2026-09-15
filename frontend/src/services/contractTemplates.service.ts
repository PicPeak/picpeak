/**
 * Admin → contract templates (#1445). Hits /api/admin/contract-templates/*.
 * A template has at most one draft and immutable published versions; every
 * content change sends the lockVersion the editor loaded.
 */
import { api } from '../config/api';
import type { ContractBlockSection } from './contracts.service';
import type { AttachmentSelection, IncludedAttachment } from './documentAttachments.service';

export type ContractLocale = 'de' | 'en' | 'fr' | 'nl' | 'pt' | 'ru';
/** Tab order in the editors: German and English first. */
export const CONTRACT_LOCALES: ContractLocale[] = ['de', 'en', 'fr', 'nl', 'pt', 'ru'];
export type LocaleText = Partial<Record<ContractLocale, string>>;

/** The placeholders contract texts may use (backend CONTRACT_PLACEHOLDERS). */
export const CONTRACT_PLACEHOLDERS = [
  'customer_name', 'customer_address', 'event_name', 'event_date', 'issue_date', 'contract_number', 'title',
  'net_days', 'skonto_percent', 'skonto_within_days', 'cancellation_30d_percent', 'currency',
  'issuer_company_name', 'issuer_address', 'source_quote_number',
] as const;

export type ContractTemplateStatus = 'draft' | 'published' | 'archived';

export interface ContractTemplateSummary {
  id: number;
  name: string;
  description: string | null;
  useCase: string | null;
  isSystem: boolean;
  status: ContractTemplateStatus;
  currentVersion: number | null;
  /** The published version new contracts from this template use. */
  currentVersionId?: number | null;
  lockVersion: number;
  isDefault: boolean;
  hasDraft?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContractTemplateItem {
  id?: number;
  position?: number;
  section: ContractBlockSection;
  kind: 'block' | 'text';
  blockId: number | null;
  block?: { slug: string | null; name: string | null; isActive: boolean; bodies: LocaleText } | null;
  heading: string | null;
  /** A block's per-template text, or a free-text section's body. */
  body: LocaleText;
  /** The block's text as frozen at publish (published versions). */
  snapshot?: LocaleText;
}

export interface ContractTemplateVersion {
  id: number;
  version: number;
  status: 'draft' | 'published' | 'superseded';
  title: string;
  introText: LocaleText;
  outroText: LocaleText;
  contentSha256: string | null;
  publishedAt: string | null;
  items?: ContractTemplateItem[];
  /** PDFs sent with contracts from this version, in order. */
  attachments?: IncludedAttachment[];
}

export interface ContractTemplateDetail {
  template: ContractTemplateSummary;
  draft: ContractTemplateVersion | null;
  published: ContractTemplateVersion | null;
  versions: ContractTemplateVersion[];
}

export interface ContractTemplateDraftPayload {
  lockVersion: number;
  name?: string;
  description?: string | null;
  useCase?: string | null;
  title?: string | null;
  introText?: LocaleText;
  outroText?: LocaleText;
  items?: Array<{
    kind: 'block' | 'text';
    blockId?: number | null;
    section?: ContractBlockSection;
    heading?: string | null;
    body?: LocaleText;
  }>;
  attachments?: AttachmentSelection[];
}

const base = '/admin/contract-templates';
const unwrap = <T>(data: { data?: T } & T): T => (data.data || data) as T;

export const contractTemplatesService = {
  async list(): Promise<{ templates: ContractTemplateSummary[] }> {
    const { data } = await api.get(base);
    return unwrap(data);
  },
  async get(id: number): Promise<ContractTemplateDetail> {
    const { data } = await api.get(`${base}/${id}`);
    return unwrap(data);
  },
  async create(payload: { name: string; description?: string | null; useCase?: string | null }): Promise<ContractTemplateDetail> {
    const { data } = await api.post(base, payload);
    return unwrap(data);
  },
  async saveDraft(id: number, payload: ContractTemplateDraftPayload): Promise<ContractTemplateDetail> {
    const { data } = await api.put(`${base}/${id}/draft`, payload);
    return unwrap(data);
  },
  async publish(id: number, lockVersion: number): Promise<ContractTemplateDetail & { version: number; contentSha256: string }> {
    const { data } = await api.post(`${base}/${id}/publish`, { lockVersion });
    return unwrap(data);
  },
  async draftFromVersion(id: number, version: number, lockVersion: number): Promise<ContractTemplateDetail> {
    const { data } = await api.post(`${base}/${id}/versions/${version}/draft`, { lockVersion });
    return unwrap(data);
  },
  async duplicate(id: number, name?: string): Promise<ContractTemplateDetail> {
    const { data } = await api.post(`${base}/${id}/duplicate`, name ? { name } : {});
    return unwrap(data);
  },
  async archive(id: number): Promise<ContractTemplateDetail> {
    const { data } = await api.post(`${base}/${id}/archive`);
    return unwrap(data);
  },
  async restore(id: number): Promise<ContractTemplateDetail> {
    const { data } = await api.post(`${base}/${id}/restore`);
    return unwrap(data);
  },
  async setDefault(id: number): Promise<ContractTemplateDetail> {
    const { data } = await api.post(`${base}/${id}/default`);
    return unwrap(data);
  },
  /** A sample PDF of the stored draft (or a version), as an object URL. */
  async previewUrl(id: number, version?: number): Promise<string> {
    const res = await api.post(`${base}/${id}/preview`, version ? { version } : {}, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },
};

/** The API's error message and code, when there is one. */
export function templateError(err: unknown): { message?: string; code?: string } {
  const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data;
  return { message: data?.error, code: data?.code };
}
