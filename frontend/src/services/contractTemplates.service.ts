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

/**
 * A placeholder contract texts may use, as the backend's registry describes
 * it (GET /placeholders). The frontend keeps no list of its own.
 */
export interface ContractPlaceholder {
  key: string;
  category: 'customer' | 'event' | 'contract' | 'pricing' | 'issuer';
  label: { en: string; de: string };
  sample: { en: string; de: string };
  /** May a "Show only if…" rule test it (a value that can be empty)? */
  conditional: boolean;
}

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

/** One problem the pre-publication check found, and where it is. */
export interface TemplateFinding {
  code: string;
  severity: 'error' | 'warning';
  /** 1-based clause position in the saved draft. */
  itemPosition?: number;
  locale?: ContractLocale;
  /** A placeholder key, or the font family for FONT_MISSING. */
  key?: string;
  field?: 'intro' | 'outro';
  attachmentId?: number;
  message: string;
}

/** The pre-publication check: findings plus a dry run of the real render. */
export interface TemplatePublishCheck {
  ok: boolean;
  pageCount: number | null;
  /** The pages each clause spans in the dry run (1-based). */
  itemPages: Array<{ position: number; firstPage: number; lastPage: number }>;
  findings: TemplateFinding[];
}

const base = '/admin/contract-templates';
const unwrap = <T>(data: { data?: T } & T): T => (data.data || data) as T;

export const contractTemplatesService = {
  async list(): Promise<{ templates: ContractTemplateSummary[] }> {
    const { data } = await api.get(base);
    return unwrap(data);
  },
  async placeholders(): Promise<{ placeholders: ContractPlaceholder[] }> {
    const { data } = await api.get(`${base}/placeholders`);
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
  /** Check the stored draft the way publishing does, with a dry-run render. */
  async check(id: number): Promise<TemplatePublishCheck> {
    const { data } = await api.post(`${base}/${id}/publish-check`);
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

/** The API's error message and code, when there is one, and a refused publish's findings. */
export function templateError(err: unknown): { message?: string; code?: string; findings?: TemplateFinding[] } {
  const data = (err as {
    response?: { data?: { error?: string; code?: string; details?: { findings?: TemplateFinding[] } } };
  })?.response?.data;
  return { message: data?.error, code: data?.code, findings: data?.details?.findings };
}
