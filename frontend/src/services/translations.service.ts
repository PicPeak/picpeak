import { api } from '../config/api';
import type { TextLanguageMode } from '../types';

/** Multilingual gallery texts (issue 2550). */
export type TranslationEntity = 'event' | 'category' | 'chapter';

export interface ContentTranslation {
  entity_type: TranslationEntity;
  /** The event's id for 'event', the category's id for 'category' and 'chapter'. */
  entity_id: number;
  field: string;
  language: string;
  text: string;
}

export interface EventTranslationsState {
  text_language_mode: TextLanguageMode;
  text_primary_language: string | null;
  text_secondary_language: string | null;
  languages: string[];
  translations: ContentTranslation[];
}

/** One change; an empty text removes that translation. */
export interface TranslationChange {
  entity_type: TranslationEntity;
  entity_id: number;
  field: string;
  language: string;
  text: string | null;
}

/** The most changes PUT /translations takes in one request (MAX_ITEMS_PER_SAVE). */
export const TRANSLATION_BATCH_SIZE = 500;

export const translationsQueryKey = (eventId: number) => ['event-translations', eventId] as const;

/** language → text for one entity's field. */
export function translationsOf(
  rows: ContentTranslation[] | undefined,
  entityType: TranslationEntity,
  entityId: number,
  field: string,
): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const row of rows || []) {
    if (row.entity_type === entityType && Number(row.entity_id) === Number(entityId) && row.field === field) out[row.language] = row.text;
  }
  return out;
}

export const translationsService = {
  async get(eventId: number): Promise<EventTranslationsState> {
    const response = await api.get<EventTranslationsState>(`/admin/events/${eventId}/translations`);
    return response.data;
  },

  async save(eventId: number, items: TranslationChange[]): Promise<EventTranslationsState> {
    const response = await api.put<EventTranslationsState>(`/admin/events/${eventId}/translations`, { items });
    return response.data;
  },
};
