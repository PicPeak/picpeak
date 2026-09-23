import { useMemo } from 'react';
import type { Photo, PhotoCategory } from '../../../types';
import type { ColorLabel } from '../../../services/feedback.service';
import type { FeedbackFilterType } from '../GalleryFilter';
import { photosInScope } from '../folders';
import { creditKeyOf } from '../../../utils/photoCredits';
export type GallerySort = 'date' | 'name' | 'size' | 'rating' | 'capture_date';
export interface GalleryFilterOptions {
  sourcePhotos?: Photo[]; categories?: PhotoCategory[]; folderId: number | string | null;
  selectedCategoryId: number | string | null; searchTerm: string; sortBy: GallerySort; sortDesc: boolean;
  watermarkEnabled: boolean; slug: string; activeFilters: FeedbackFilterType[]; activeColorFilters: ColorLabel[];
  mediaFilter: 'all' | 'photo' | 'video'; isGuestIdentityMode: boolean;
  myFeedbackPhotoIds: Record<FeedbackFilterType, Set<number>>; selectedPersonIds: number[]; peopleMatchAny: boolean;
  // "By" filter (#1561): a key from utils/photoCredits, null = everyone.
  selectedCreditKey?: string | null;
}
export const resolveMediaType = (photo: Photo): 'photo' | 'video' =>
  photo.media_type === 'video' || photo.mime_type?.startsWith('video/') || photo.type === 'video' ? 'video' : 'photo';
export function useGalleryFiltering({ sourcePhotos, categories, folderId, selectedCategoryId, searchTerm, sortBy, sortDesc, watermarkEnabled, slug, activeFilters, activeColorFilters, mediaFilter, isGuestIdentityMode, myFeedbackPhotoIds, selectedPersonIds, peopleMatchAny, selectedCreditKey = null }: GalleryFilterOptions) {
  return useMemo(() => {
    if (!sourcePhotos) return [];

    // Folder containment (#1160) comes FIRST: at root this drops every photo that
    // lives in a folder, inside a folder it keeps only that folder's photos.
    // Everything below narrows within that scope, so a search or a feedback chip
    // never reaches across a folder boundary.
    let photos = photosInScope(sourcePhotos, categories, folderId);

    if (mediaFilter === 'photo') {
      photos = photos.filter(photo => resolveMediaType(photo) !== 'video');
    } else if (mediaFilter === 'video') {
      photos = photos.filter(photo => resolveMediaType(photo) === 'video');
    }

    // Apply category filter. Only meaningful at root — inside a folder every
    // photo already shares the folder's category.
    if (selectedCategoryId && !folderId) {
      photos = photos.filter(photo => photo.category_id === selectedCategoryId);
    }

    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      photos = photos.filter(photo => 
        photo.filename.toLowerCase().includes(term)
      );
    }
    
    // Apply feedback filters. Multi-select (#889): a photo matching ANY
    // active filter passes (OR-combined); an empty set means no feedback
    // filtering. In guest identity mode each filter has to scope to the
    // *current guest's* interactions (#538 bug 1) — the aggregate counts
    // on each photo row are global across all guests, which gave an empty
    // grid when the guest had liked photos that nobody else had touched.
    // Falls back to the aggregate-count check in simple/non-guest mode
    // where there's no per-person identity to scope by.
    if (activeFilters.length > 0) {
      const matchers: Record<FeedbackFilterType, (photo: Photo) => boolean> = {
        liked: (photo) => isGuestIdentityMode
          ? myFeedbackPhotoIds.liked.has(photo.id)
          : (photo.like_count || 0) > 0,
        favorited: (photo) => isGuestIdentityMode
          ? myFeedbackPhotoIds.favorited.has(photo.id)
          : (photo.favorite_count || 0) > 0,
        rated: (photo) => isGuestIdentityMode
          ? myFeedbackPhotoIds.rated.has(photo.id)
          : (photo.average_rating || 0) > 0 || (photo.total_ratings || 0) > 0,
        commented: (photo) => isGuestIdentityMode
          ? myFeedbackPhotoIds.commented.has(photo.id)
          : (photo.comment_count || 0) > 0,
      };
      photos = photos.filter(photo => activeFilters.some(filter => matchers[filter](photo)));
    }

    // Apply people filter (#1074). Composes with every filter above rather
    // than replacing them, so "photos of Anna that I liked" works.
    //
    // Two people selected means AND by default ("photos with both Anna and
    // Ben") — that is what someone picking a second face is almost always
    // asking for. `peopleMatchAny` flips it to OR for the couple-shots case.
    if (selectedPersonIds.length > 0) {
      photos = photos.filter(photo => {
        const ids = photo.person_ids || [];
        return peopleMatchAny
          ? selectedPersonIds.some(id => ids.includes(id))
          : selectedPersonIds.every(id => ids.includes(id));
      });
    }

    // Apply the "By" filter (#1561). Composes with the rest, so "Anna's photos
    // that I liked" works.
    if (selectedCreditKey) {
      photos = photos.filter(photo => creditKeyOf(photo) === selectedCreditKey);
    }

    // Apply colour-label filters (#1044). Guest-scoped by construction:
    // `my_color_label` is the requesting viewer's own label, which is what a
    // proofing client means by "show me my greens". Composes with (ANDs
    // against) every filter above, like the people filter.
    if (activeColorFilters.length > 0) {
      photos = photos.filter(photo =>
        !!photo.my_color_label && activeColorFilters.includes(photo.my_color_label as ColorLabel)
      );
    }

    // Apply sorting
    // Each comparator defaults to its natural order (desc for dates/size/rating, asc for name).
    // The flip multiplier reverses that when sortDesc differs from the natural order.
    const flip = sortDesc ? 1 : -1;
    photos.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          // Natural order is ascending (A-Z); flip when sortDesc=true
          return (sortDesc ? -1 : 1) * a.filename.localeCompare(b.filename);
        case 'size':
          return flip * (b.size - a.size);
        case 'rating': {
          const ratingA = a.average_rating || 0;
          const ratingB = b.average_rating || 0;
          if (ratingA !== ratingB) {
            return flip * (ratingB - ratingA);
          }
          return flip * ((b.comment_count || 0) - (a.comment_count || 0));
        }
        case 'capture_date': {
          const captureDateA = a.captured_at || a.uploaded_at;
          const captureDateB = b.captured_at || b.uploaded_at;
          return flip * (new Date(captureDateB).getTime() - new Date(captureDateA).getTime());
        }
        case 'date':
        default:
          return flip * (new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
      }
    });
    
    // Transform full-size URLs for watermarks if enabled
    // Note: Thumbnails are watermarked server-side at the thumbnail endpoint
    if (watermarkEnabled) {
      photos = photos.map(photo => ({
        ...photo,
        url: `/api/gallery/${slug}/photo/${photo.id}`
      }));
    }
    
    return photos;
  }, [sourcePhotos, categories, folderId, selectedCategoryId, searchTerm, sortBy, sortDesc, watermarkEnabled, slug, activeFilters, activeColorFilters, mediaFilter, isGuestIdentityMode, myFeedbackPhotoIds, selectedPersonIds, peopleMatchAny, selectedCreditKey]);
}
