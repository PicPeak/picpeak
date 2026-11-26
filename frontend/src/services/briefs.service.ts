/**
 * Admin → project briefs (issue 2678). Hits /api/admin/briefs/*.
 *
 * Templates are field lists: one global, one per occasion (event type slug).
 * A brief belongs to a project or to a customer without a project; its
 * values are sent as a map of field id → { value?, visible? }.
 */
import { api } from '../config/api';

export const BRIEF_FIELD_TYPES = [
  'short_text', 'long_text', 'date', 'time', 'datetime', 'place', 'place_time', 'number', 'yes_no',
  'project_date', 'project_location', 'project_guests',
] as const;
export type BriefFieldType = typeof BRIEF_FIELD_TYPES[number];

/** A place (and for place_time its time, HH:MM). */
export interface BriefPlace { place: string; address: string; time?: string }
export type BriefValue = string | number | boolean | BriefPlace | null;

export interface BriefTemplateField {
  /** Absent on a field not saved yet. */
  id?: number;
  label: string;
  /** { <language>: label }. */
  labels: Partial<Record<string, string>>;
  type: BriefFieldType;
  visibleDefault: boolean;
}

export interface BriefTemplates {
  global: BriefTemplateField[];
  occasions: Record<string, BriefTemplateField[]>;
}

export interface BriefField extends Required<Pick<BriefTemplateField, 'id'>>, Omit<BriefTemplateField, 'id'> {
  /** `removed`: no longer in the template; readable, can only be cleared. */
  source: 'global' | 'occasion' | 'removed';
  value: BriefValue;
  /** The brief's own choice; null follows visibleDefault. */
  visible: boolean | null;
  /** The project's own data, edited in the project data card. */
  fromProject: boolean;
}

export interface BriefPendingChange {
  /** null: the shared arrangements. */
  fieldId: number | null;
  label: string | null;
  labels: Partial<Record<string, string>>;
  /** `renamed`: the same value under a corrected label; `reordered`: the
   *  fields the customer sees are in a new order (fieldId null). */
  change: 'added' | 'changed' | 'removed' | 'renamed' | 'reordered';
}

export interface Brief {
  occasion: string | null;
  /** The title the customer sees; null uses defaultTitle (the occasion's name). */
  title: string | null;
  defaultTitle: string | null;
  fields: BriefField[];
  sharedArrangements: string;
  notifiedAt: string | null;
  pendingChanges: BriefPendingChange[];
  hasCustomer: boolean;
}

export interface BriefSavePayload {
  values?: Record<number, { value?: BriefValue; visible?: boolean | null }>;
  sharedArrangements?: string | null;
  title?: string | null;
  /** Customer briefs only. */
  occasion?: string | null;
}

export interface BriefOwner { kind: 'projects' | 'customers'; id: number }

export const briefsService = {
  async templates(): Promise<BriefTemplates> {
    const { data } = await api.get<{ templates: BriefTemplates }>('/admin/briefs/templates');
    return data.templates;
  },
  /** `occasion` null saves the global template. */
  async saveTemplate(occasion: string | null, fields: BriefTemplateField[]): Promise<BriefTemplateField[]> {
    const { data } = await api.put<{ fields: BriefTemplateField[] }>(
      `/admin/briefs/templates/${encodeURIComponent(occasion ?? 'global')}`, { fields },
    );
    return data.fields;
  },
  async get(owner: BriefOwner): Promise<Brief> {
    const { data } = await api.get<{ brief: Brief }>(`/admin/briefs/${owner.kind}/${owner.id}`);
    return data.brief;
  },
  async save(owner: BriefOwner, payload: BriefSavePayload): Promise<Brief> {
    const { data } = await api.put<{ brief: Brief }>(`/admin/briefs/${owner.kind}/${owner.id}`, payload);
    return data.brief;
  },
  /** `suppressed`: the customer takes no administrative email; the portal has the update. */
  async notify(owner: BriefOwner): Promise<{ notifiedAt: string; changes: number; mail: 'queued' | 'suppressed' }> {
    const { data } = await api.post(`/admin/briefs/${owner.kind}/${owner.id}/notify`);
    return data;
  },
};
