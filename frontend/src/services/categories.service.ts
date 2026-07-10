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
  created_at: string;
}

export interface CreateCategoryData {
  name: string;
  slug?: string;
  is_global?: boolean;
  event_id?: number;
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
    patch?: { allow_downloads?: boolean }
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
  }
};