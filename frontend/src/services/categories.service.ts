import { api } from '../config/api';

export interface PhotoCategory {
  id: number;
  name: string;
  slug: string;
  is_global: boolean;
  event_id: number | null;
  hero_photo_id?: number | null;
  // Per-category download permission (#640). Defaults true (server-side) so
  // categories created before migration 135 keep working.
  allow_downloads?: boolean;
  // Global default sort order (#782). Backfilled from the previous alphabetical
  // order on migration, so existing galleries don't reshuffle.
  display_order?: number;
  // Per-event override position (#782). Non-null on the /event/:id response when
  // this gallery has customised its order; null means it follows the default.
  override_position?: number | null;
  // Folder vs filter (#1160). false (the default) is the historical behaviour:
  // the category filters the root grid. true makes it a container — its photos
  // leave the root grid and only render inside the folder.
  is_folder?: boolean;
  created_at: string;
}

export interface CreateCategoryData {
  name: string;
  slug?: string;
  is_global?: boolean;
  event_id?: number;
  is_folder?: boolean;
}

export const categoriesService = {
  // Get all global categories
  async getGlobalCategories(): Promise<PhotoCategory[]> {
    const response = await api.get<PhotoCategory[]>('/admin/categories/global');
    return response.data;
  },

  // Get categories for a specific event (global + event-specific)
  async getEventCategories(eventId: number): Promise<PhotoCategory[]> {
    const response = await api.get<PhotoCategory[]>(`/admin/categories/event/${eventId}`);
    return response.data;
  },

  // Create a new category
  async createCategory(data: CreateCategoryData): Promise<PhotoCategory> {
    const response = await api.post<PhotoCategory>('/admin/categories', data);
    return response.data;
  },

  // Update a category. `name` is required by the backend validator; the other
  // fields are optional patches. Per-category `allow_downloads` is the #640
  // hook so admins can disable downloads for one category while keeping
  // everything else downloadable.
  async updateCategory(
    id: number,
    name: string,
    patch?: { allow_downloads?: boolean; is_folder?: boolean }
  ): Promise<PhotoCategory> {
    const response = await api.put<PhotoCategory>(`/admin/categories/${id}`, { name, ...patch });
    return response.data;
  },

  // Set category hero photo (#163)
  async setCategoryHeroPhoto(id: number, heroPhotoId: number | null): Promise<PhotoCategory> {
    const response = await api.put<PhotoCategory>(`/admin/categories/${id}/hero`, { hero_photo_id: heroPhotoId });
    return response.data;
  },

  // Delete a category
  async deleteCategory(id: number): Promise<void> {
    await api.delete(`/admin/categories/${id}`);
  },

  // Set a per-event order override (#782). Sends the full ordered id list for
  // this event — globals + event-specific — and returns the resolved order.
  // Overrides the global default for this gallery only.
  async reorderCategories(eventId: number, orderedIds: number[]): Promise<PhotoCategory[]> {
    const response = await api.post<PhotoCategory[]>('/admin/categories/reorder', {
      event_id: eventId,
      orderedIds
    });
    return response.data;
  },

  // Clear an event's override — revert this gallery to the global default order.
  async resetEventOrder(eventId: number): Promise<PhotoCategory[]> {
    const response = await api.delete<PhotoCategory[]>(`/admin/categories/reorder/${eventId}`);
    return response.data;
  },

  // Set the GLOBAL default order for shared categories (#782). Applies to every
  // gallery that hasn't set its own override.
  async reorderGlobalCategories(orderedIds: number[]): Promise<PhotoCategory[]> {
    const response = await api.post<PhotoCategory[]>('/admin/categories/reorder-global', {
      orderedIds
    });
    return response.data;
  }
};