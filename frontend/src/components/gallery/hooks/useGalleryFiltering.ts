import { useMemo } from 'react';
import type { Photo, PhotoCategory } from '../../../types';
import type { ColorLabel } from '../../../services/feedback.service';
import type { FeedbackFilterType } from '../GalleryFilter';
import { photosInView } from '../folders';
import { creditKeyOf } from '../../../utils/photoCredits';
import { photoMatchesFilenameSearch, photoNameCompare } from '../../../utils/photoFilename';
export type GallerySort = 'date' | 'name' | 'size' | 'rating' | 'capture_date';
export interface GalleryFilterOptions {
  sourcePhotos?: Photo[]; categories?: PhotoCategory[]; folderId: number | string | null;
  // "All photos" (issue 1786): containment off, every photo in one grid.
  viewAll?: boolean;
  selectedCategoryId: number | string | null; searchTerm: string; sortBy: GallerySort; sortDesc: boolean;
  watermarkEnabled: boolean; slug: string; activeFilters: FeedbackFilterType[]; activeColorFilters: ColorLabel[];
  mediaFilter: 'all' | 'photo' | 'video'; isGuestIdentityMode: boolean;
  myFeedbackPhotoIds: Record<FeedbackFilterType, Set<number>>; selectedPersonIds: number[]; peopleMatchAny: boolean;
  // "By" filter (#1561): a key from utils/photoCredits, null = everyone.
  selectedCreditKey?: string | null;
  // Minimum own star rating (issue 1733, A3c), 1-5; null = no rating filter.
  minRating?: number | null;
  // Scene tags (issue 1733): a photo passes when it carries ANY of them.
  selectedTagKeys?: string[];
  // Premium and Story: "Liked" means the viewer's own likes (`is_liked`),
  // the same set their heart toggles and their nav count read.
  likedIsOwn?: boolean;
}
export const resolveMediaType = (photo: Photo): 'photo' | 'video' =>
  photo.media_type === 'video' || photo.mime_type?.startsWith('video/') || photo.type === 'video' ? 'video' : 'photo';
export function useGalleryFiltering({ sourcePhotos, categories, folderId, viewAll = false, selectedCategoryId, searchTerm, sortBy, sortDesc, watermarkEnabled, slug, activeFilters, activeColorFilters, mediaFilter, isGuestIdentityMode, myFeedbackPhotoIds, selectedPersonIds, peopleMatchAny, selectedCreditKey = null, minRating = null, selectedTagKeys, likedIsOwn = false }: GalleryFilterOptions) {
  return useMemo(() => {
    if (!sourcePhotos) return [];

    // Folder containment (#1160) comes FIRST: at root this drops every photo that
    // lives in a folder, inside a folder it keeps only that folder's photos.
    // Everything below narrows within that scope, so a search or a feedback chip
    // never reaches across a folder boundary. "All photos" (issue 1786) turns
    // containment off.
    let photos = photosInView(sourcePhotos, categories, folderId, viewAll);

    if (mediaFilter === 'photo') {
      photos = photos.filter(photo => resolveMediaType(photo) !== 'video');
    } else if (mediaFilter === 'video') {
      photos = photos.filter(photo => resolveMediaType(photo) === 'video');
    }

    // Apply category filter. Since issue 1786 a folder lives in `folder_id`
    // and `category_id` is a filter only, so this narrows inside a folder and
    // in "All photos" as well as at root.
    if (selectedCategoryId) {
      photos = photos.filter(photo => photo.category_id === selectedCategoryId);
    }

    // Apply search filter
    if (searchTerm) {
      photos = photos.filter(photo => photoMatchesFilenameSearch(photo, searchTerm));
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
        liked: (photo) => likedIsOwn
          ? Boolean(photo.is_liked)
          : isGuestIdentityMode
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

    // Apply the scene-tag filter (issue 1733). Several tags are OR-combined
    // ("cake or dancing"): tags describe a scene, and two scenes rarely share
    // a photo, so AND would mostly empty the grid. Composes with (ANDs
    // against) every other filter.
    if (selectedTagKeys && selectedTagKeys.length > 0) {
      photos = photos.filter(photo => (photo.tag_keys || []).some(key => selectedTagKeys.includes(key)));
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

    // Apply the minimum own-rating filter (issue 1733, A3c). `my_rating` is
    // the viewer's own stars (null when unrated or ratings are off), so this
    // is guest-scoped like the colour chips and ANDs against everything above:
    // "Saved" + "3+" is "saved photos I rated three stars or more".
    if (minRating) {
      photos = photos.filter(photo => (photo.my_rating || 0) >= minRating);
    }

    // Apply sorting
    // Each comparator defaults to its natural order (desc for dates/size/rating, asc for name).
    // The flip multiplier reverses that when sortDesc differs from the natural order.
    const flip = sortDesc ? 1 : -1;
    photos.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          // Natural order is ascending (A-Z); flip when sortDesc=true
          return (sortDesc ? -1 : 1) * photoNameCompare(a, b);
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
  }, [sourcePhotos, categories, folderId, viewAll, selectedCategoryId, searchTerm, sortBy, sortDesc, watermarkEnabled, slug, activeFilters, activeColorFilters, mediaFilter, isGuestIdentityMode, myFeedbackPhotoIds, selectedPersonIds, peopleMatchAny, selectedCreditKey, minRating, selectedTagKeys, likedIsOwn]);
}
