/**
 * Event Types Service
 * API client for event type management
 */

import { api } from '../config/api';

export interface EventType {
  id: number;
  name: string;
  slug_prefix: string;
  emoji: string;
  theme_preset: string;
  theme_config: string | null;
  display_order: number;
  is_system: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateEventTypeData {
  name: string;
  slug_prefix: string;
  emoji?: string;
  theme_preset?: string;
  theme_config?: Record<string, unknown>;
  display_order?: number;
}

export interface UpdateEventTypeData {
  name?: string;
  slug_prefix?: string;
  emoji?: string;
  theme_preset?: string;
  theme_config?: Record<string, unknown>;
  display_order?: number;
  is_active?: boolean;
}

export const eventTypesService = {
  /**
   * Get all event types (for admin management)
   */
  async getEventTypes(includeInactive = false): Promise<EventType[]> {
    const response = await api.get<{ eventTypes: EventType[] }>('/admin/event-types', {
      params: { includeInactive: includeInactive.toString() }
    });
    return response.data.eventTypes;
  },

  /**
   * Get only active event types (for dropdowns/selection)
   */
  async getActiveEventTypes(): Promise<EventType[]> {
    const response = await api.get<{ eventTypes: EventType[] }>('/admin/event-types/active');
    return response.data.eventTypes;
  },

  /**
   * Get a single event type by ID
   */
  async getEventType(id: number): Promise<EventType> {
    const response = await api.get<EventType>(`/admin/event-types/${id}`);
    return response.data;
  },

  /**
   * Create a new event type
   */
  async createEventType(data: CreateEventTypeData): Promise<EventType> {
    const response = await api.post<EventType>('/admin/event-types', data);
    return response.data;
  },

  /**
   * Update an event type
   */
  async updateEventType(id: number, data: UpdateEventTypeData): Promise<EventType> {
    const response = await api.put<EventType>(`/admin/event-types/${id}`, data);
    return response.data;
  },

  /**
   * Delete an event type
   */
  async deleteEventType(id: number): Promise<void> {
    await api.delete(`/admin/event-types/${id}`);
  },

  /**
   * Reorder event types
   */
  async reorderEventTypes(orderedIds: number[]): Promise<EventType[]> {
    const response = await api.post<{ eventTypes: EventType[] }>('/admin/event-types/reorder', {
      orderedIds
    });
    return response.data.eventTypes;
  }
};
