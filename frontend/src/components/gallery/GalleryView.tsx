import { GalleryProductPanel } from '../../features/album-products/GalleryProductPanel';
import { useGalleryFiltering, resolveMediaType } from './hooks/useGalleryFiltering';
import { useGalleryUpload } from './hooks/useGalleryUpload';
import { useLiveRefresh } from './hooks/useLiveRefresh';
import { useGallerySelection } from './hooks/useGallerySelection';
import { useFeedbackChange } from './hooks/useFeedbackChange';
import { UploadProcessingNotice } from './UploadProcessingNotice';
import { NewPhotosPill } from './NewPhotosPill';
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { differenceInDays, parseISO } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';

import { Button } from '../common';
import { GallerySkeleton } from './GallerySkeleton';
import { PasswordChangeRequiredNotice } from './PasswordChangeRequiredNotice';
import { isAdminSessionExpired, isPasswordChangeRequired } from '../../utils/passwordChangeRequired';
import { useGalleryAuth, useTheme } from '../../contexts';
import { useGalleryPhotos, useDownloadAllPhotos } from '../../hooks/useGallery';
import { PhotoGridWithLayouts } from './PhotoGridWithLayouts';
import { GalleryFolderTiles } from './GalleryFolderTiles';
import { GalleryBreadcrumb } from './GalleryBreadcrumb';
import { GalleryViewSwitch } from './GalleryViewSwitch';
import { GalleryDeliveryBanner } from './GalleryDeliveryBanner';
import { GalleryTileBadgesProvider, type GalleryTileBadgesValue } from './GalleryTileBadges';
import { PhotoLabelsProvider } from './PhotoLabels';
import {
  findFolderByKey,
  filterCategories,
  folderAncestors,
  folderCategoryIds,
  folderTiles,
  folderTree,
  peopleInScope,
  photoFolderId,
  photosInScope,
  photosInSubtree,
  photosInView,
  SELECTED_DOWNLOAD_LIMIT,
  folderKey,
  readFolderParam,
  readViewParam,
  writeFolderParam,
  writeViewParam,
  type GalleryViewMode,
} from './folders';
import {
  leavePhotoParam,
  pushPhotoParam,
  readPhotoParam,
  replacePhotoParam,
  resolvePhotoLink,
  type LightboxPhotoChangeReason,
} from './photoLink';
import { DownloadResolutionModal } from './DownloadResolutionModal';
import { PhotoDownloadChoiceProvider } from './PhotoDownloadChoiceProvider';
import { clearDownloadJobParam, readDownloadJobParam } from './downloadJobLink';
import { CopyFilenamesDialog } from './CopyFilenamesDialog';
import { ExpirationBanner } from './ExpirationBanner';
import { CountdownTimer } from './CountdownTimer';
import { GalleryLayout } from './GalleryLayout';
import { GallerySidebar } from './GallerySidebar';
import { GalleryClientAccessDialog } from './GalleryClientAccessDialog';
import { GalleryToolbar } from './GalleryToolbar';
import { GalleryFilterPanel } from './GalleryFilterPanel';
import { GalleryCategoryChips } from './GalleryCategoryChips';
import { GridDensityControl } from './GridDensityControl';
import { GridDensityOffered, layoutHasDensity } from './gridDensity';
import { UserPhotoUpload } from './UserPhotoUpload';
import { tagChipsFor } from './TagFilterChips';
import { creditGroups, uploaderRequiresEmail } from '../../utils/photoCredits';
import { hasVideoItems } from '../../utils/mediaCounts';
import { isFilenameListFavourite, photosForFilenameList } from '../../utils/photoFilename';
import { GuestNamePromptModal } from './GuestNamePromptModal';
import { GuestRecoveryModal } from './GuestRecoveryModal';
import { PeopleStrip } from './PeopleStrip';
import { PeopleSheet } from './PeopleSheet';
import { GuestIdentityProvider } from '../../contexts/GuestIdentityContext';
import { SelectionSubmitBar, selectionStateKey, useSelectionPickRefresh } from './SelectionSubmitBar';
import { DownloadQuotaProvider, buildDownloadQuotaValue } from '../../contexts/DownloadQuotaContext';
import { isDownloadLimitError, isSelectionTooLargeError, quotaFromEvent, showDownloadLimitReached, type QuotaPhoto } from '../../utils/downloadLimit';
import { DownloadQuotaNotice } from './DownloadQuotaNotice';
import type { FilterType, FeedbackFilterType } from './GalleryFilter';
import { analyticsService } from '../../services/analytics.service';
import { useDevToolsProtection } from '../../hooks/useDevToolsProtection';
import { beginPhotoDownload, endPhotoDownload, touchPhotoDownload, PHOTO_DOWNLOAD_STALE_MS } from '../../hooks/usePhotoDownloadPending';
import { Upload, Menu, Eye, EyeOff, Shield, X, Download, ClipboardList, AlertCircle } from 'lucide-react';
import { galleryService, splitIntoArchives } from '../../services/gallery.service';
import { feedbackService, type ColorLabel } from '../../services/feedback.service';
import { useWatermarkSettings } from '../../hooks/useWatermarkSettings';
import { useGalleryCustomCss } from '../../hooks/useGalleryCustomCss';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import type { Photo } from '../../types';
import { GALLERY_THEME_PRESETS } from '../../types/theme.types';
import { useQueryClient } from '@tanstack/react-query';

interface GalleryViewProps {
  slug: string;
  event: {
    id: number;
    event_name: string;
    event_type: string;
    event_date: string | null;
    welcome_message?: string;
    color_theme?: string;
    expires_at: string | null;
    allow_user_uploads?: boolean;
    upload_category_id?: number | null;
    hero_photo_id?: number | null;
    allow_downloads?: boolean;
    // Banner overrides come from /gallery/:slug/info (the /photos response
    // does NOT carry them) and are spread straight through to GalleryLayout.
    promo_mode?: 'inherit' | 'custom' | 'off';
    promo_markdown?: string | null;
    info_mode?: 'inherit' | 'custom' | 'off';
    info_markdown?: string | null;
  };
  /**
   * Whether this gallery is password-protected (#1149).
   *
   * Drives the Logout button. Logging out of a gallery that asks for nothing
   * is meaningless — there is no credential to drop and nothing to return to
   * — and it used to strand the visitor: GalleryPage's auto-login is a
   * one-shot latch, so clearing the session left the page rendering its
   * skeleton until a manual reload.
   *
   * A client (PIN) session still gets the button on a public gallery: that
   * one IS a credential, and it is the only way back to the guest view. So is
   * a customer-portal session — see `via_customer` on the /photos response.
   */
  requiresPassword?: boolean;
}

// Convert default_photo_sort DB value to internal sortBy state
const parseDefaultPhotoSort = (defaultSort?: string): { sortBy: 'date' | 'name' | 'size' | 'rating' | 'capture_date'; sortDesc: boolean } => {
  switch (defaultSort) {
    case 'upload_date_asc':
      return { sortBy: 'date', sortDesc: false };
    case 'capture_date_desc':
      return { sortBy: 'capture_date', sortDesc: true };
    case 'capture_date_asc':
      return { sortBy: 'capture_date', sortDesc: false };
    case 'filename_asc':
      return { sortBy: 'name', sortDesc: false };
    case 'filename_desc':
      return { sortBy: 'name', sortDesc: true };
    case 'upload_date_desc':
    default:
      return { sortBy: 'date', sortDesc: true };
  }
};

export const GalleryView: React.FC<GalleryViewProps> = ({ slug, event, requiresPassword = true }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const { logout, endSession, isClient, viaCustomer, viaClientPin, enterClientMode, leaveClientMode, isSwitchingClientMode } = useGalleryAuth();
  const accessScope = isClient ? 'client' : viaCustomer ? 'customer' : 'guest';
  const { setTheme, theme } = useTheme();
  const queryClient = useQueryClient();
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | string | null>(null);
  // Open folder (#1160), mirrored to `?folder=<slug>` so it is linkable and the
  // browser back button walks out of it. Seeded from the URL on first render.
  const [openFolderSlug, setOpenFolderSlug] = useState<string | null>(() => readFolderParam());
  // "Folders | All photos" (issue 1786), mirrored to `?view=all`.
  const [galleryView, setGalleryView] = useState<GalleryViewMode>(() => readViewParam());
  // Link to a single photo (issue 1733). `pendingPhotoLink` is a `?photo=`
  // still to be checked against the loaded list — the deep link on arrival,
  // or a Back/Forward step; `linkedPhotoId` is the photo the lightbox is
  // asked to show, and is kept in step with the lightbox's own moves.
  const [pendingPhotoLink, setPendingPhotoLink] = useState<number | null>(() => readPhotoParam());
  const [linkedPhotoId, setLinkedPhotoId] = useState<number | null>(null);
  // Download size picker (#858). `showResolutionPicker` covers "download all";
  // `resolutionPickerIds` covers a selection (sidebar / full-page layouts).
  const [showResolutionPicker, setShowResolutionPicker] = useState(false);
  // Filename list dialog (issue 1733, A3d).
  const [showCopyFilenames, setShowCopyFilenames] = useState(false);
  const [resolutionPickerIds, setResolutionPickerIds] = useState<number[] | null>(null);
  // The picker was opened for the guest's selection (not a people filter or
  // a folder), so a download it hands over ends the selection, as the
  // sidebar's direct download does.
  const [pickerForSelection, setPickerForSelection] = useState(false);
  // The job a "your download is ready" mail links to (issue 1733). This view
  // only mounts behind the gallery's own access check. The token leaves the
  // address bar when its dialog is closed.
  const [resumeJobToken, setResumeJobToken] = useState<string | null>(() => readDownloadJobParam());
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'size' | 'rating' | 'capture_date'>('date');
  const [sortDesc, setSortDesc] = useState(true);
  const [defaultSortApplied, setDefaultSortApplied] = useState(false);
  const [brandingSettings, setBrandingSettings] = useState<any>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showClientAccess, setShowClientAccess] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const { watermarkEnabled } = useWatermarkSettings();

  // Load and inject custom CSS for this gallery
  useGalleryCustomCss(slug);

  const [protectionLevel, setProtectionLevel] = useState<'basic' | 'standard' | 'enhanced' | 'maximum'>('standard');
  // Multi-select feedback filters (#889): OR-combined; empty = "All".
  // Clicking a filter toggles it, clicking "All" clears the set.
  const [activeFilters, setActiveFilters] = useState<FeedbackFilterType[]>([]);
  // Colour-label filters (#1044) live in their own slice rather than as five
  // more members of FeedbackFilterType: every exhaustive
  // Record<FeedbackFilterType, …> in this file and the chip components would
  // otherwise have to grow to ten keys.
  const [activeColorFilters, setActiveColorFilters] = useState<ColorLabel[]>([]);
  // Minimum own-rating filter (issue 1733, A3c): 1-5, null = off. Its own
  // slice for the same reason as the colour filters.
  const [minRating, setMinRating] = useState<number | null>(null);

  // People filter (#1074). Multi-select, AND by default — see the filter
  // block below. `peopleMatchAny` only becomes reachable once a second
  // person is picked, since the toggle is meaningless for one.
  const [selectedPersonIds, setSelectedPersonIds] = useState<number[]>([]);
  const [peopleMatchAny, setPeopleMatchAny] = useState(false);
  // "By" filter (#1561): who took or uploaded the photo. null = everyone.
  const [selectedCreditKey, setSelectedCreditKey] = useState<string | null>(null);
  // Scene-tag filter (issue 1733). Multi-select; several tags are OR-combined.
  const [selectedTagKeys, setSelectedTagKeys] = useState<string[]>([]);
  const [showPeopleSheet, setShowPeopleSheet] = useState(false);
  // Dismissal is per gallery: a guest who hides the bar in one gallery has
  // said nothing about the next one.
  const [peopleCollapsed, setPeopleCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`picpeak_people_collapsed_${slug}`) === '1';
    } catch {
      return false;
    }
  });
  const handlePeopleCollapsedChange = (collapsed: boolean) => {
    setPeopleCollapsed(collapsed);
    try {
      localStorage.setItem(`picpeak_people_collapsed_${slug}`, collapsed ? '1' : '0');
    } catch {
      // Private-mode Safari throws on setItem; the in-memory state still works.
    }
  };
  const togglePerson = (personId: number) => {
    setSelectedPersonIds((prev) => {
      const next = prev.includes(personId)
        ? prev.filter((id) => id !== personId)
        : [...prev, personId];
      // Dropping back below two people makes the any/all toggle meaningless;
      // reset it so it doesn't silently persist into the next selection.
      if (next.length < 2) setPeopleMatchAny(false);
      return next;
    });
  };
  const handleFilterChange = (filter: FilterType) => {
    if (filter === 'all') {
      setActiveFilters([]);
    } else {
      setActiveFilters(prev => prev.includes(filter)
        ? prev.filter(f => f !== filter)
        : [...prev, filter]);
    }
  };
  const [mediaFilter, setMediaFilter] = useState<'all' | 'photo' | 'video'>('all');
  const [guestId, setGuestId] = useState<string>('');
  const [staticHeroPhoto, setStaticHeroPhoto] = useState<Photo | null>(null);

  // Generate a unique guest ID for this session
  useEffect(() => {
    // Use existing guest ID from localStorage or generate new one
    let storedGuestId = localStorage.getItem('gallery_guest_id');
    if (!storedGuestId) {
      storedGuestId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('gallery_guest_id', storedGuestId);
    }
    setGuestId(storedGuestId);
  }, []);
  
  // Fetch photos WITHOUT filter (always get all photos, filter on frontend)
  // This ensures counts are always calculated from the full dataset
  const { data, isLoading, error, refetch } = useGalleryPhotos(slug, 'all', guestId, !isSwitchingClientMode, accessScope);
  const handleFeedbackChange = useFeedbackChange(slug, refetch, { patchRows: !isClient });
  const { isSelectionMode, setIsSelectionMode, selectedPhotos, setSelectedPhotos } = useGallerySelection(data?.photos);
  
  // Set protection level when data is available
  useEffect(() => {
    if (data?.event?.protection_level) {
      setProtectionLevel(data.event.protection_level);
    }
  }, [data?.event?.protection_level]);

  // Apply default photo sort from event settings
  useEffect(() => {
    if (!defaultSortApplied && data?.event?.default_photo_sort) {
      const { sortBy: defaultSortBy, sortDesc: defaultSortDesc } = parseDefaultPhotoSort(data.event.default_photo_sort);
      setSortBy(defaultSortBy);
      setSortDesc(defaultSortDesc);
      setDefaultSortApplied(true);
    }
  }, [data?.event?.default_photo_sort, defaultSortApplied]);

  // Reveal mode (#838): an already-open view must follow reveal-state
  // changes in BOTH directions — hidden→visible at reveal_at (or manual
  // "Reveal now"), and visible→hidden on a re-hide. Refetch right at
  // reveal_at plus a 60s poll while the mode is armed; there is no push
  // channel.
  const hiddenUntilReveal = data?.hidden_until_reveal === true;
  const revealArmed = (data?.event as { reveal_armed?: boolean } | undefined)?.reveal_armed === true;
  const revealAtMs = data?.reveal_at ? new Date(data.reveal_at).getTime() : null;
  useEffect(() => {
    if (!hiddenUntilReveal && !revealArmed) return undefined;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    if (revealAtMs && revealAtMs > Date.now()) {
      timers.push(setTimeout(() => { refetch(); }, Math.min(revealAtMs - Date.now() + 1000, 2 ** 31 - 1)));
    }
    const interval = setInterval(() => { refetch(); }, 60_000);
    return () => { timers.forEach(clearTimeout); clearInterval(interval); };
  }, [hiddenUntilReveal, revealArmed, revealAtMs, refetch]);

  const { uploadProcessing, handleUploadComplete } = useGalleryUpload(slug, refetch, () => setShowUploadModal(false));

  const uploadProcessingNotice = <UploadProcessingNotice processing={uploadProcessing} />;

  // Get individual protection settings from event
  const disableRightClick = data?.event?.disable_right_click === true;
  const enableDevtoolsProtection = data?.event?.enable_devtools_protection === true;
  const useCanvasRendering = data?.event?.use_canvas_rendering === true;
  // #508 — surface original camera filenames in the lightbox when the
  // admin has flipped the same toggle that drives original-name downloads.
  // Neutral photo labels (issue 1733, E6): "Photo 12 of 84" in place of the
  // filename. It wins over the original-filename toggle above for display;
  // downloads are named by that toggle as before.
  const neutralPhotoLabels = data?.event?.neutral_photo_labels === true;
  const showOriginalFilename = !neutralPhotoLabels && data?.event?.use_original_filenames === true;

  // DevTools protection - enabled by individual setting OR legacy protection level
  const devToolsEnabled = enableDevtoolsProtection || protectionLevel === 'enhanced' || protectionLevel === 'maximum';

  useDevToolsProtection({
    enabled: devToolsEnabled,
    detectionSensitivity: protectionLevel === 'maximum' ? 'high' : 'medium',
    onDevToolsDetected: () => {
      console.warn('DevTools detected in gallery view');

      // Track analytics
      analyticsService.track('gallery_devtools_detected', { protectionLevel });

      // For maximum protection, redirect away from gallery
      if (protectionLevel === 'maximum') {
        setTimeout(() => {
          window.location.href = '/';
        }, 100);
      }
    },
    redirectOnDetection: protectionLevel === 'maximum',
    redirectUrl: '/'
  });

  // Right-click blocking - separate from DevTools protection
  useEffect(() => {
    if (!disableRightClick) return;

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [disableRightClick]);
  
  // Data updates are handled by React Query
  const downloadAllMutation = useDownloadAllPhotos();
  // Issue 2043: "Download selected" while it is still running ignores a
  // repeat click, and its button shows it is busy. The ref catches a second
  // click before the state has re-rendered. Like a photo's own mark, the run
  // lets go after a minute without progress, so a request that never settles
  // does not disable the button until a reload; the id keeps a late finish of
  // a run that already let go from releasing a newer one.
  const selectedRunRef = useRef<{ id: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const lastSelectedRunRef = useRef(0);
  const [downloadingSelected, setDownloadingSelected] = useState(false);
  const releaseSelectedRun = useCallback((id: number) => {
    const run = selectedRunRef.current;
    if (!run || run.id !== id) return;
    clearTimeout(run.timer);
    selectedRunRef.current = null;
    setDownloadingSelected(false);
  }, []);
  // Leaving the view stops the run before its next photo, and its timer
  // with it.
  useEffect(() => () => {
    const run = selectedRunRef.current;
    if (run) clearTimeout(run.timer);
    selectedRunRef.current = null;
  }, []);
  const keepSelectedRunAlive = useCallback((id: number) => {
    const run = selectedRunRef.current;
    if (!run || run.id !== id) return;
    clearTimeout(run.timer);
    run.timer = setTimeout(() => releaseSelectedRun(id), PHOTO_DOWNLOAD_STALE_MS);
  }, [releaseSelectedRun]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const { data: settingsData } = usePublicSettings();

  // Fetch feedback settings
  const { data: feedbackSettings } = useQuery({
    queryKey: ['gallery-feedback-settings', event.id],
    queryFn: async () => {
      try {
        // Use public endpoint to get feedback settings
        return await feedbackService.getGalleryFeedbackSettings(slug);
      } catch (error) {
        console.error('Error fetching feedback settings:', error);
        // If endpoint doesn't exist or returns error, default to disabled
        return { feedback_enabled: false };
      }
    },
    enabled: !!event.id,
  });

  // Uploader names (#1561): the upload dialog's name step, from the /photos
  // payload.
  const uploaderNameProps = {
    slug,
    nameMode: data?.event?.guest_name_mode ?? 'off',
    creditsVisible: data?.event?.credits_visible === true,
    requireEmail: uploaderRequiresEmail(feedbackSettings),
    maxEdge: data?.event?.guest_upload_max_edge ?? null,
  } as const;

  // People in this gallery (#1074).
  //
  // Gated on people_enabled so an install without the feature never fires the
  // request at all. Polls only while a backfill is running — a finished
  // gallery has a stable people list, and polling it forever would be a
  // request per guest per interval for no new information.
  // From the /photos payload, not the prop: the prop's event shape comes
  // from /info, which does not carry this flag.
  const peopleEnabled = data?.event?.people_enabled === true;
  // Automatic scene tags (issue 1733), from the same payload.
  const tagsEnabled = data?.event?.tags_enabled === true;
  const { data: peopleData } = useQuery({
    queryKey: ['gallery-people', slug, accessScope],
    queryFn: () => galleryService.getPeople(slug),
    enabled: peopleEnabled,
    refetchInterval: (query) => (query.state.data?.scan?.in_progress ? 5000 : false),
    staleTime: 30_000,
  });
  // Live refresh (issue 1733, C5), per-gallery opt-in. Stands down while
  // something else already keeps the list current: the reveal poll, the
  // viewer's own upload being followed, a people scan refetching the photos.
  const loadedMaxId = useMemo(
    () => (data?.photos || []).reduce<number | null>((max, p) => (max === null || p.id > max ? p.id : max), null),
    [data?.photos],
  );
  const newPhotoCount = useLiveRefresh({
    slug,
    // revealArmed too: the reveal poll above keeps refetching the list after
    // the reveal, for as long as the mode is on.
    enabled: data?.event?.live_refresh === true && !hiddenUntilReveal && !revealArmed && !uploadProcessing
      && !peopleData?.scan?.in_progress,
    loadedCount: data?.photos?.length ?? 0,
    loadedMaxId,
  });
  const newPhotosPill = <NewPhotosPill count={newPhotoCount} onClick={() => { void refetch(); }} />;

  // Memoised so the `people` recount below isn't invalidated by a fresh []
  // identity on every render.
  const allPeople = useMemo(() => peopleData?.people || [], [peopleData?.people]);

  // Folders (#1160, nested since issue 1786). A gallery "has folders" when
  // the root has at least one folder tile; without one the switch and the
  // breadcrumb never render and the gallery looks exactly as before.
  const rootTiles = useMemo(
    () => folderTiles(data?.categories, data?.photos, null),
    [data?.categories, data?.photos]
  );
  const hasFolders = rootTiles.length > 0;
  // "All photos": containment off. Ignored for a gallery without folders,
  // where the root already is every photo.
  const viewAll = hasFolders && galleryView === 'all';

  // `openFolder` resolves the `?folder=` slug against the categories the
  // gallery actually returned, so a stale or hand-typed slug simply falls back
  // to root instead of rendering an empty gallery.
  const openFolder = useMemo(
    () => (viewAll ? null : findFolderByKey(data?.categories, openFolderSlug)),
    [data?.categories, openFolderSlug, viewAll]
  );
  const openFolderId = openFolder?.id ?? null;

  // Tiles for the subfolders of the current level; none in "All photos".
  const tiles = useMemo(
    () => (viewAll ? [] : openFolderId === null ? rootTiles : folderTiles(data?.categories, data?.photos, openFolderId)),
    [viewAll, openFolderId, rootTiles, data?.categories, data?.photos]
  );
  const folderTrail = useMemo(
    () => folderAncestors(data?.categories, openFolderId),
    [data?.categories, openFolderId]
  );
  const sidebarFolderTree = useMemo(
    () => (hasFolders ? folderTree(data?.categories, data?.photos) : []),
    [hasFolders, data?.categories, data?.photos]
  );
  const rootPhotoCount = useMemo(
    () => (hasFolders ? photosInScope(data?.photos, data?.categories, null).length : 0),
    [hasFolders, data?.photos, data?.categories]
  );

  // Photos the current view is allowed to show, before any user-applied filter.
  // This — not `filteredPhotos` — is the right basis for the people strip and
  // the category counts: scoping those by the person filter would zero out
  // every other face the moment one is picked.
  const scopedPhotos = useMemo(
    () => photosInView(data?.photos, data?.categories, openFolderId, viewAll),
    [data?.photos, data?.categories, openFolderId, viewAll]
  );

  // Per-tile badges (issues 1562, 1786): the first-look pill whenever the
  // gallery is a two-stage delivery (it stays after completion), and in "All
  // photos" the folder each photo lives in, since the grid no longer says.
  const delivery = data?.event?.delivery ?? null;
  const tileBadges = useMemo<GalleryTileBadgesValue>(() => {
    let folderNameOf: GalleryTileBadgesValue['folderNameOf'] = null;
    if (viewAll) {
      const folderIds = new Set([...folderCategoryIds(data?.categories)].map(String));
      const names = new Map((data?.categories || []).map((c) => [String(c.id), c.name]));
      folderNameOf = (photo) => {
        const id = photoFolderId(photo, folderIds);
        return id !== null ? names.get(id) || null : null;
      };
    }
    return {
      firstLookLabel: delivery ? (delivery.badge_label || t('gallery.firstLook', 'First look')) : null,
      folderNameOf,
    };
  }, [viewAll, data?.categories, delivery, t]);

  const people = useMemo(() => peopleInScope(allPeople, scopedPhotos), [allPeople, scopedPhotos]);

  // A credit filter whose name is gone from the scope (erased by "Forget me",
  // renamed by the host) would keep emptying the grid while the chips, and
  // with them "Everyone", are hidden. Drop it (#1561).
  useEffect(() => {
    if (!selectedCreditKey || !data?.photos) return;
    if (!creditGroups(scopedPhotos).some((group) => group.key === selectedCreditKey)) {
      setSelectedCreditKey(null);
    }
  }, [selectedCreditKey, scopedPhotos, data?.photos]);

  // The strip comes from /people, but FILTERING uses photo.person_ids, which
  // rides on the one-shot /photos response. During a backfill those drift
  // apart: new faces appear in the strip while the photo memberships behind
  // them are still the set fetched on page load, so tapping a person yields
  // zero or a partial result until a manual reload — including after the scan
  // has finished.
  //
  // Refetch the photos whenever the scan's progress changes, and once more on
  // the transition to finished.
  const scanProgress = peopleData?.scan
    ? `${peopleData.scan.in_progress}:${peopleData.scan.scanned}`
    : null;
  useEffect(() => {
    if (!peopleEnabled || !scanProgress) return;
    queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
  }, [scanProgress, peopleEnabled, slug, queryClient]);

  // Update feedbackEnabled when settings change
  useEffect(() => {
    if (feedbackSettings) {
      setFeedbackEnabled(feedbackSettings.feedback_enabled || false);
    }
  }, [feedbackSettings]);

  // In guest identity mode both the "Liked / Favorited / Rated /
  // Commented" filters AND the matching chip-count labels need to scope
  // to the *current guest's* interactions, not the global aggregates on
  // each photo row (#538 bug 1). Pull the current guest's feedback via
  // /my-feedback (already keyed by x-guest-token in the api interceptor)
  // and build per-type photo-id sets so both consumers below can do
  // O(1) lookups.
  //
  // Always-on in guest mode (not gated on the active filter) because
  // the chip counts render whether or not a feedback filter is selected
  // — gating on activeFilters would leave "Liked (0)" stale until the user
  // clicks the chip, which is the same UX cliff bug 1 was reporting.
  const isGuestIdentityMode = feedbackSettings?.identity_mode === 'guest';

  // Finish selection / approve edited photos (issue 1733, A1): the viewer's
  // own state. Its "x of y selected" counter is fed from /my-feedback below,
  // in every identity mode, so it follows each like without a request of its
  // own; galleries without a counter keep /my-feedback to guest mode.
  const { data: selectionState } = useQuery({
    queryKey: selectionStateKey(slug),
    queryFn: () => feedbackService.getSelectionState(slug),
    enabled: !!slug && !!feedbackSettings?.feedback_enabled,
    staleTime: 30 * 1000,
  });
  const selectionCounterOn = !!selectionState?.selection.counter;
  useSelectionPickRefresh(slug, !!selectionState);

  const { data: myFeedbackRows } = useQuery<Array<{
    photo_id: number;
    feedback_type: 'like' | 'favorite' | 'rating' | 'comment';
  }>>({
    queryKey: ['my-feedback', slug],
    queryFn: () => feedbackService.getMyFeedback(slug),
    enabled: (isGuestIdentityMode || selectionCounterOn) && !!slug,
    staleTime: 30 * 1000,
  });

  // One pick per photo, whichever of the gallery's pick types marks it.
  const selectionUsed = useMemo(() => {
    if (!selectionState) return 0;
    if (!myFeedbackRows) return selectionState.selection.used;
    const pickTypes: string[] = selectionState.selection.pick_types;
    return new Set(
      myFeedbackRows.filter((row) => pickTypes.includes(row.feedback_type)).map((row) => row.photo_id),
    ).size;
  }, [selectionState, myFeedbackRows]);
  const selectionBarShown = !!selectionState
    && (selectionState.selection.counter || selectionState.approval.can_submit);

  const myFeedbackPhotoIds = useMemo(() => {
    const sets = {
      liked: new Set<number>(),
      favorited: new Set<number>(),
      rated: new Set<number>(),
      commented: new Set<number>(),
    };
    if (!myFeedbackRows) return sets;
    for (const row of myFeedbackRows) {
      if (row.feedback_type === 'like') sets.liked.add(row.photo_id);
      else if (row.feedback_type === 'favorite') sets.favorited.add(row.photo_id);
      else if (row.feedback_type === 'rating') sets.rated.add(row.photo_id);
      else if (row.feedback_type === 'comment') sets.commented.add(row.photo_id);
    }
    return sets;
  }, [myFeedbackRows]);

  // Apply branding settings
  useEffect(() => {
    if (settingsData) {
      setBrandingSettings({
        company_name: settingsData.branding_company_name || '',
        company_tagline: settingsData.branding_company_tagline || '',
        support_email: settingsData.branding_support_email || '',
        footer_text: settingsData.branding_footer_text || '',
        watermark_enabled: settingsData.branding_watermark_enabled || false,
        logo_url: settingsData.branding_logo_url || null,
        logo_url_dark: settingsData.branding_logo_url_dark || null,
        logo_size: settingsData.branding_logo_size || 'medium',
        logo_max_height: settingsData.branding_logo_max_height || 48,
        logo_position: settingsData.branding_logo_position || 'left',
        logo_display_header: settingsData.branding_logo_display_header !== false,
        logo_display_hero: settingsData.branding_logo_display_hero !== false,
        logo_display_mode: settingsData.branding_logo_display_mode || 'logo_and_text',
        // Footer overhaul (#441 + #440). All five socials are optional;
        // empty strings → that icon is hidden. promo_markdown is the
        // global default; per-event override happens in GalleryLayout.
        facebook_url: settingsData.branding_facebook_url || '',
        instagram_url: settingsData.branding_instagram_url || '',
        whatsapp_url: settingsData.branding_whatsapp_url || '',
        twitter_url: settingsData.branding_twitter_url || '',
        youtube_url: settingsData.branding_youtube_url || '',
        promo_markdown: settingsData.branding_promo_markdown || '',
        info_markdown: settingsData.branding_info_markdown || '',
        promo_position: settingsData.branding_promo_position === 'below_footer' ? 'below_footer' : 'above_footer',
        // Promo alignment (#482). Defaults to 'center' to match the
        // gallery footer; see GalleryLayout.
        promo_alignment: settingsData.branding_promo_alignment || 'center',
      });
    }
  }, [settingsData]);

  // Scoped (#1160): a Video chip offered at root for a video that only exists
  // inside a folder filters to an empty grid.
  const availableMediaTypes = useMemo(() => {
    const types = new Set<'photo' | 'video'>();
    scopedPhotos.forEach((photo) => {
      const mediaType = resolveMediaType(photo);
      if (mediaType === 'photo' || mediaType === 'video') {
        types.add(mediaType);
      }
    });
    return types;
  }, [scopedPhotos]);

  const showMediaFilter = availableMediaTypes.has('photo') && availableMediaTypes.has('video');

  useEffect(() => {
    if (!showMediaFilter && mediaFilter !== 'all') {
      setMediaFilter('all');
    }
  }, [showMediaFilter, mediaFilter]);

  // Determine the default hero photo from the initial (unfiltered) load
  const [defaultHeroPhoto, setDefaultHeroPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    if (!defaultHeroPhoto && data?.photos && activeFilters.length === 0) {
      let hero: Photo | null = null;
      const heroId = data?.event?.hero_photo_id || null;
      if (heroId) {
        hero = data.photos.find(p => p.id === heroId) || null;
      }
      if (!hero && data.photos.length > 0) {
        const firstPhoto = data.photos.find(p => resolveMediaType(p) === 'photo');
        hero = firstPhoto || data.photos[0];
      }
      if (hero) {
        setDefaultHeroPhoto(hero);
        setStaticHeroPhoto(hero);
      }
    }
  }, [data?.photos, data?.event?.hero_photo_id, activeFilters, defaultHeroPhoto]);

  // Switch hero photo when a category with its own hero image is selected
  useEffect(() => {
    if (!data?.photos || !defaultHeroPhoto) return;

    if (selectedCategoryId) {
      const category = (data.categories || []).find(c => c.id === selectedCategoryId);
      if (category?.hero_photo_id) {
        const categoryHero = data.photos.find(p => p.id === category.hero_photo_id);
        if (categoryHero) {
          setStaticHeroPhoto(categoryHero);
          return;
        }
      }
    }
    // No category selected or category has no hero — revert to default
    setStaticHeroPhoto(defaultHeroPhoto);
  }, [selectedCategoryId, data?.categories, data?.photos, defaultHeroPhoto]);

  // Apply theme when settings are loaded
  useEffect(() => {
    if (settingsData && data?.event) {
      let themeToApply = null;
      const fullEvent = data.event; // Use the full event data from API

      if (fullEvent.color_theme) {
        try {
          // Check if it's a valid JSON string
          if (fullEvent.color_theme.startsWith('{')) {
            const eventTheme = JSON.parse(fullEvent.color_theme);
            themeToApply = eventTheme;
          } else {
            // Handle legacy theme names - check if it's a preset
            const preset = GALLERY_THEME_PRESETS[fullEvent.color_theme];
            if (preset) {
              themeToApply = preset.config;
            } else {
              // Unknown theme name, fall back to global theme
              if (settingsData.theme_config) {
                themeToApply = settingsData.theme_config;
              }
            }
          }
        } catch {
          // Invalid theme format - use default
          // Fall back to global theme
          if (settingsData.theme_config) {
            themeToApply = settingsData.theme_config;
          }
        }
      } else if (settingsData.theme_config) {
        // No event theme, use global theme
        themeToApply = settingsData.theme_config;
      }

      // Apply theme with a small delay to ensure it overrides any global theme.
      // Instance-wide force color mode is enforced inside ThemeContext.applyTheme,
      // so callers don't have to wrap the theme themselves.
      if (themeToApply) {
        // Use setTimeout to ensure this runs after any global theme application
        const timer = setTimeout(() => {
          // If there's a hero photo, add it to gallery settings
          if (fullEvent.hero_photo_id && themeToApply.gallerySettings) {
            themeToApply.gallerySettings.heroImageId = fullEvent.hero_photo_id;
            // Apply hero photo ID to existing gallery settings
          } else if (fullEvent.hero_photo_id) {
            themeToApply.gallerySettings = { heroImageId: fullEvent.hero_photo_id };
            // Create gallery settings with hero photo ID
          }
          setTheme(themeToApply);
        }, 0);

        return () => clearTimeout(timer);
      }
    }
  }, [settingsData, data, setTheme]); // Use data instead of event prop

  // Client visibility toggle handler (#172)
  const handleToggleVisibility = async (photoId: number, currentVisibility: string) => {
    const newVisibility = currentVisibility === 'hidden' ? 'visible' : 'hidden';
    try {
      await galleryService.togglePhotoVisibility(slug, photoId, newVisibility);
      queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
    } catch (error) {
      console.error('Failed to toggle visibility:', error);
    }
  };

  const handleBulkVisibility = async (visibility: 'visible' | 'hidden') => {
    if (selectedPhotos.size === 0) return;
    try {
      await galleryService.bulkToggleVisibility(slug, Array.from(selectedPhotos), visibility);
      setSelectedPhotos(new Set());
      setIsSelectionMode(false);
      queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
    } catch (error) {
      console.error('Failed to bulk toggle visibility:', error);
    }
  };

  // Client visibility stats
  const visibleCount = useMemo(() => {
    if (!isClient || !data?.photos) return 0;
    return data.photos.filter(p => p.visibility !== 'hidden').length;
  }, [isClient, data?.photos]);

  const totalCount = data?.photos?.length || 0;

  // Calculate days until expiration (null means never expires)
  const daysUntilExpiration = event.expires_at
    ? differenceInDays(parseISO(event.expires_at), new Date())
    : null;
  const showUrgentWarning = daysUntilExpiration !== null && daysUntilExpiration <= 7;
  const isExpired = daysUntilExpiration !== null && daysUntilExpiration < 0;


  // Entering or leaving a folder, or switching views, is a scope change, not a
  // filter change.
  const resetScopeState = useCallback(() => {
    // Carrying a category selection across would contradict the new scope.
    setSelectedCategoryId(null);
    // The grid only auto-clears its selection when `categoryId` changes, and
    // that is already null at root — so without this a selection made outside
    // the folder survives into it, and the toolbar would offer to download (or
    // a client to hide) photos that are no longer on screen.
    setSelectedPhotos(new Set());
    // A person picked in the previous scope may have no photos here, and
    // peopleInScope drops them from the strip — leaving an invisible filter that
    // empties the grid with no control left to clear it.
    setSelectedPersonIds([]);
    setPeopleMatchAny(false);
    // Same for a credit name (#1561): the chips hide a name with no photos
    // in the new scope, and with it the only way to clear the filter.
    setSelectedCreditKey(null);
    setSelectedTagKeys([]);
  }, [setSelectedPhotos]);

  const openFolderBySlug = useCallback((key: string | null) => {
    setOpenFolderSlug(key);
    // Folder navigation always happens in the folders view (issue 1786).
    setGalleryView('folders');
    writeFolderParam(key);
    resetScopeState();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [resetScopeState]);

  const changeGalleryView = useCallback((view: GalleryViewMode) => {
    setGalleryView(view);
    setOpenFolderSlug(null);
    writeViewParam(view);
    resetScopeState();
  }, [resetScopeState]);

  // The address bar is the source of truth, so Back/Forward walk in and out of
  // folders instead of leaving the gallery.
  useEffect(() => {
    const onPop = () => {
      const folderParam = readFolderParam();
      const viewParam = readViewParam();
      // Only a folder or view change is a scope change. Back out of a photo
      // (issue 1733) lands on the same grid, filters included.
      if (folderParam !== openFolderSlug || viewParam !== galleryView) {
        setOpenFolderSlug(folderParam);
        setGalleryView(viewParam);
        resetScopeState();
      }
      // Back closes the lightbox, Forward reopens it. An id is checked against
      // the loaded list like a deep link, so it can switch folders too.
      const photoParam = readPhotoParam();
      if (photoParam === null) {
        setLinkedPhotoId(null);
        // A link still queued for resolution (its folder or filter not yet
        // settled) must not reopen the lightbox on the grid we just came back to.
        setPendingPhotoLink(null);
      } else {
        setPendingPhotoLink(photoParam);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [resetScopeState, openFolderSlug, galleryView]);

  // Premium and Story have no `favorite` control: their hearts write `like`
  // feedback and seed from `is_liked`, so there a like is the favourite. Their
  // nav heart drives the "Liked" filter, which then keeps the viewer's own
  // likes rather than every photo anyone liked.
  const favouritesAreLikes = theme.galleryLayout === 'gallery-premium' || theme.galleryLayout === 'gallery-story';
  const filteredPhotos = useGalleryFiltering({
    sourcePhotos: data?.photos, categories: data?.categories, folderId: openFolderId, viewAll,
    selectedCategoryId, searchTerm, sortBy, sortDesc, watermarkEnabled, slug,
    activeFilters, activeColorFilters, mediaFilter, isGuestIdentityMode, myFeedbackPhotoIds,
    selectedPersonIds, peopleMatchAny,
    // Only while names are visible: a stale key must not keep filtering a
    // gallery whose host has just switched names off.
    selectedCreditKey: data?.event?.credits_visible ? selectedCreditKey : null,
    // Only while ratings are on: the chips hide with the switch, and a stale
    // threshold would otherwise keep emptying the grid with no way to clear
    // it. The master switch counts too — turning feedback off keeps
    // allow_ratings as it was, and the chips hide with feedbackEnabled.
    minRating: feedbackSettings?.feedback_enabled && feedbackSettings?.allow_ratings ? minRating : null,
    // Only while tagging is on for the gallery: the chips hide with it.
    selectedTagKeys: tagsEnabled ? selectedTagKeys : undefined,
    likedIsOwn: favouritesAreLikes,
  });
  // `scopedPhotos` is the same scope with every search and filter off: tells
  // "nothing matches" from "nothing here yet" when the grid comes out empty.
  const emptyIsFiltered = filteredPhotos.length === 0 && scopedPhotos.length > 0;
  const creditsVisible = data?.event?.credits_visible === true;

  // Tag chips (issue 1733): the gallery's tags, counted over the scope.
  const tagChips = useMemo(
    () => (tagsEnabled ? tagChipsFor(data?.tags, scopedPhotos, selectedTagKeys) : []),
    [tagsEnabled, data?.tags, scopedPhotos, selectedTagKeys],
  );
  const toggleTag = useCallback((key: string) => {
    setSelectedTagKeys(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  }, []);

  // Resolve a `?photo=` against the photos this viewer has loaded (issue
  // 1733) — never by fetching the id. A photo in another folder switches the
  // folder (replace, not push: Back must not land on a root the visitor never
  // saw); one hidden by a filter clears the filters; an unknown id is dropped
  // from the URL without a word. Waits for the reveal (#838): the list is
  // empty until then and the link would be lost for nothing.
  useEffect(() => {
    if (pendingPhotoLink === null || !data?.photos || hiddenUntilReveal) return;
    setPendingPhotoLink(null);
    const resolved = resolvePhotoLink(data.photos, data.categories, pendingPhotoLink);
    if (!resolved) {
      replacePhotoParam(null);
      return;
    }
    const targetFolderId = resolved.folder?.id ?? null;
    // In "All photos" every photo is already on screen (issue 1786); only the
    // folders view has to open the photo's folder, at whatever depth.
    if (!viewAll && targetFolderId !== openFolderId) {
      const key = resolved.folder ? folderKey(resolved.folder) : null;
      setOpenFolderSlug(key);
      writeFolderParam(key, { replace: true });
      setSelectedPhotos(new Set());
    }
    if (!filteredPhotos.some((photo) => photo.id === resolved.photo.id)) {
      setSelectedCategoryId(null);
      setSearchTerm('');
      setActiveFilters([]);
      setActiveColorFilters([]);
      setMediaFilter('all');
      setSelectedPersonIds([]);
      setPeopleMatchAny(false);
      setSelectedCreditKey(null);
      setSelectedTagKeys([]);
    }
    setLinkedPhotoId(resolved.photo.id);
  }, [pendingPhotoLink, data?.photos, data?.categories, hiddenUntilReveal, viewAll, openFolderId, filteredPhotos, setSelectedPhotos]);

  // The lightbox's own moves, mirrored to the URL (photoLink.ts): one pushed
  // entry per opening, rewritten while stepping, left on close.
  const handleLightboxPhotoChange = useCallback((photoId: number | null, reason: LightboxPhotoChangeReason) => {
    setLinkedPhotoId(photoId);
    if (reason === 'open' && photoId !== null) {
      pushPhotoParam(photoId);
    } else if (reason === 'step' && photoId !== null) {
      replacePhotoParam(photoId);
    } else if (reason === 'close') {
      leavePhotoParam();
    }
  }, []);

  // Counts shown in the filter chips ("Liked (N)", etc.). In guest
  // mode these need to mirror the per-guest filter behaviour above —
  // otherwise the chip says "Liked (5)" globally but clicking it
  // surfaces 3 (the guest's own subset), which is the same confusing
  // mismatch #538 reported for the filter itself. Fall back to the
  // global aggregate in simple mode where no per-person identity
  // exists.
  const likeCount = useMemo(() => {
    // Scoped (#1160): a chip counting another folder's likes advertises matches
    // that clicking it — which filters scopedPhotos — can never produce.
    if (isGuestIdentityMode) {
      return scopedPhotos.filter(p => myFeedbackPhotoIds.liked.has(p.id)).length;
    }
    return scopedPhotos.filter(p => (p.like_count ?? 0) > 0).length;
  }, [scopedPhotos, isGuestIdentityMode, myFeedbackPhotoIds]);

  const favoriteCount = useMemo(() => {
    if (isGuestIdentityMode) {
      return scopedPhotos.filter(p => myFeedbackPhotoIds.favorited.has(p.id)).length;
    }
    return scopedPhotos.filter(p => (p.favorite_count ?? 0) > 0).length;
  }, [scopedPhotos, isGuestIdentityMode, myFeedbackPhotoIds]);

  const ratedCount = useMemo(() => {
    if (isGuestIdentityMode) {
      return scopedPhotos.filter(p => myFeedbackPhotoIds.rated.has(p.id)).length;
    }
    return scopedPhotos.filter(p => (p.total_ratings || 0) > 0 || (p.average_rating || 0) > 0).length;
  }, [scopedPhotos, isGuestIdentityMode, myFeedbackPhotoIds]);

  // Per-colour chip counts (#1044) — the viewer's own labels, matching what
  // the filter actually selects.
  const colorLabelCounts = useMemo(() => {
    const counts: Partial<Record<ColorLabel, number>> = {};
    for (const photo of scopedPhotos) {
      const label = photo.my_color_label as ColorLabel | null | undefined;
      if (!label) continue;
      counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
  }, [scopedPhotos]);

  const handleColorFilterToggle = useCallback((color: ColorLabel) => {
    setActiveColorFilters(prev =>
      prev.includes(color) ? prev.filter(c => c !== color) : [...prev, color]
    );
  }, []);

  // Per-threshold chip counts (issue 1733, A3c): how many photos in scope the
  // viewer rated at or above each threshold, matching what the filter selects.
  const minRatingCounts = useMemo(() => {
    const counts: Partial<Record<number, number>> = {};
    for (const photo of scopedPhotos) {
      const rating = photo.my_rating || 0;
      for (let min = 1; min <= rating; min++) {
        counts[min] = (counts[min] || 0) + 1;
      }
    }
    return counts;
  }, [scopedPhotos]);

  // "Select all" over the photos the active filters leave on screen (issue
  // 1733, A3c), for the sidebar — the inline grid toolbar's own Select All
  // already works on the filtered list it is handed.
  const selectAllVisible = useCallback(() => {
    setSelectedPhotos(new Set(filteredPhotos.map((photo) => photo.id)));
  }, [filteredPhotos, setSelectedPhotos]);
  const deselectAll = useCallback(() => {
    setSelectedPhotos(new Set());
  }, [setSelectedPhotos]);
  // The filter panel's last step (issue 1733, E7): exactly what the filters
  // leave on screen, with the toolbar switched to its batch actions.
  const selectFiltered = useCallback(() => {
    selectAllVisible();
    setIsSelectionMode(true);
  }, [selectAllVisible, setIsSelectionMode]);
  // The toolbar's X: selection mode off and the selection gone with it, or
  // the toolbar, which swaps on a non-empty selection, would stay swapped.
  const cancelSelection = useCallback(() => {
    setSelectedPhotos(new Set());
    setIsSelectionMode(false);
  }, [setSelectedPhotos, setIsSelectionMode]);
  // The filters that live in the toolbar's filter panel; categories, search
  // and people have their own controls on the page.
  const activePanelFilterCount = activeFilters.length + activeColorFilters.length
    + (minRating !== null ? 1 : 0) + (mediaFilter !== 'all' ? 1 : 0)
    + (selectedCreditKey !== null ? 1 : 0) + selectedTagKeys.length;
  const clearPanelFilters = () => {
    setActiveFilters([]);
    setActiveColorFilters([]);
    setMinRating(null);
    setMediaFilter('all');
    setSelectedCreditKey(null);
    setSelectedTagKeys([]);
  };
  // Selection tray in the sidebar (issue 1733, A3e).
  const deselectPhoto = useCallback((photoId: number) => {
    setSelectedPhotos((previous) => {
      const next = new Set(previous);
      next.delete(photoId);
      return next;
    });
  }, [setSelectedPhotos]);

  // Check if downloads are allowed (both event setting and not expired)
  const allowDownloads = !isExpired && (data?.event?.allow_downloads === true);

  // Guest uploads: the refetched /photos payload decides once it is here. The
  // `event` prop is the snapshot the page loaded with, so OR-ing it in kept the
  // upload button after an admin turned uploads off.
  const allowUploads = data?.event
    ? data.event.allow_user_uploads === true
    : event?.allow_user_uploads === true;

  // Resolution picker choices (#858). More than one option means there is an
  // actual choice to make; a single option is just the standard size, so skip
  // the modal and download straight away.
  const downloadChoices = data?.event?.download_resolution?.picker_enabled
    ? (data.event.download_resolution.choices || [])
    : [];
  // The single-photo download menu (issue 1733, E2) and what every size
  // menu says about the watermark.
  const downloadChoiceProps = {
    slug,
    choices: downloadChoices,
    watermarked: data?.event?.download_resolution?.watermarked === true,
  };

  // Download limit (issue 1560). Checked before any request so the guest sees
  // why at once; the server enforces it regardless.
  const downloadQuota = useMemo(() => buildDownloadQuotaValue(quotaFromEvent(data?.event)), [data?.event]);
  const photosById = useMemo(
    () => new Map((data?.photos || []).map((photo) => [photo.id, photo])),
    [data?.photos]
  );
  // What /download-all ships: every photo this viewer sees, minus categories
  // that opted out of downloads (#640).
  const allDownloadablePhotos = useMemo(
    () => (data?.photos || []).filter((photo) => photo.category_allow_downloads !== false),
    [data?.photos]
  );
  const photosForIds = useCallback(
    (ids: number[]): QuotaPhoto[] => ids.map((id) => photosById.get(id) || { id }),
    [photosById]
  );
  // Selection tray in the sidebar (issue 1733, A3e), in the order selected.
  const selectedPhotoList = useMemo(
    () => Array.from(selectedPhotos).flatMap((id) => photosById.get(id) ?? []),
    [selectedPhotos, photosById]
  );
  // The whole selection, priced by id for the toolbar's download (issue 1560).
  const selectedQuotaPhotos = useMemo(
    () => photosForIds(Array.from(selectedPhotos)),
    [photosForIds, selectedPhotos]
  );
  const refuseOverQuota = (photos: QuotaPhoto[]): boolean => {
    if (downloadQuota.allows(photos)) return false;
    showDownloadLimitReached({ remaining: downloadQuota.remaining ?? 0 });
    return true;
  };

  // Copyable filename list (issue 1733, A3d): the selection, or the viewer's
  // favourites when nothing is selected. Favourites use the same predicate as
  // the "Favorited" filter — the guest's own in identity mode, the aggregate in
  // simple mode — and span the whole gallery: the list is for finding the
  // masters in a RAW editor, which has no notion of this gallery's folders.
  //
  // Premium and Story have no `favorite` control: their Favourites toggle
  // writes `like` feedback and seeds from `is_liked`, so there a like is the
  // favourite (see isFilenameListFavourite, and `favouritesAreLikes` above).
  //
  // Empty under neutral photo labels (issue 1733, E6): the list is nothing but
  // the camera names that setting keeps off screen, and every "Copy filenames"
  // button is gated on its length.
  const copyFilenames = useMemo(() => photosForFilenameList(
    neutralPhotoLabels ? [] : data?.photos || [],
    selectedPhotos,
    (photo) => isFilenameListFavourite(photo, {
      likeBacked: favouritesAreLikes,
      guestIdentity: isGuestIdentityMode,
      myLiked: myFeedbackPhotoIds.liked,
      myFavorited: myFeedbackPhotoIds.favorited,
      // The identity mode is known only from a successful load: the public
      // settings always carry identity_mode, the query's error fallback
      // ({ feedback_enabled: false }) does not. Pending or failed, no
      // favourites are offered — the aggregate fallback would list other
      // guests' favourites in a guest-identity gallery.
      settingsResolved: feedbackSettings?.identity_mode !== undefined,
    }),
    isSelectionMode,
  ), [data?.photos, neutralPhotoLabels, selectedPhotos, isSelectionMode, isGuestIdentityMode, myFeedbackPhotoIds, favouritesAreLikes, feedbackSettings]);

  const handleDownloadAll = () => {
    // Prevent downloads if gallery is expired or downloads disabled
    if (!allowDownloads) {
      return;
    }
    if (refuseOverQuota(allDownloadablePhotos)) return;

    // Hand off to the picker; it builds the archive as a job and downloads it.
    if (downloadChoices.length > 1) {
      setShowResolutionPicker(true);
      return;
    }

    downloadAllMutation.mutate({ slug, zipReady: data?.event?.download_zip_ready });
    
    // Track download all action
    analyticsService.trackGalleryEvent('bulk_download', {
      gallery: slug,
      photo_count: data?.photos.length || 0,
      is_download_all: true
    });
  };

  const handleDownloadSelected = async () => {
    if (selectedPhotos.size === 0) return;
    if (selectedRunRef.current) return;

    // Prevent downloads if gallery is expired or downloads disabled
    if (!allowDownloads) {
      return;
    }
    if (refuseOverQuota(photosForIds(Array.from(selectedPhotos)))) return;

    // Resolution picker (#858): sidebar-driven selections get the same choice
    // as the grid's own control, rather than silently downloading at the
    // gallery standard.
    if (downloadChoices.length > 1) {
      setResolutionPickerIds(Array.from(selectedPhotos));
      setPickerForSelection(true);
      return;
    }

    const runId = ++lastSelectedRunRef.current;
    selectedRunRef.current = { id: runId, timer: setTimeout(() => releaseSelectedRun(runId), PHOTO_DOWNLOAD_STALE_MS) };
    setDownloadingSelected(true);
    let stillCurrent = true;
    try {
      // Track bulk download
      analyticsService.trackGalleryEvent('bulk_download', {
        gallery: slug,
        photo_count: selectedPhotos.size
      });

      // Download limit (issue 1560): one zip, which the server grants whole or
      // not at all. Photo by photo, a refusal halfway through would already have
      // charged the ones before it. A refusal keeps the selection to trim. A
      // preview-only guest gets one zip too, which leaves out the videos they
      // cannot take rather than failing on them one by one.
      //
      // The whole selection (issue 1972), as the picker branch above hands over:
      // a search or filter applied after selecting hides photos, it does not
      // unselect them.
      //
      // The gallery toolbar (every controls style but the sidebar) has always
      // handed the selection over as one zip as well, and still does (issue
      // 1733, E8); only the sidebar fetches photo by photo.
      const asToolbarZip = theme.controlsStyle !== 'sidebar';
      if (asToolbarZip || downloadQuota.limited || downloadQuota.previewOnly) {
        if (asToolbarZip && !downloadQuota.limited && !downloadQuota.previewOnly) {
          toast.info(t('gallery.downloading', { count: selectedPhotoList.length }));
        }
        try {
          await galleryService.downloadSelectedPhotos(
            slug,
            selectedPhotoList.map((p) => p.id),
            undefined,
            () => keepSelectedRunAlive(runId),
          );
        } catch (error) {
          // A refusal keeps the selection, to trim it to what is left; so does
          // a selection over the server's per-download cap, which the service
          // has already explained.
          if (isDownloadLimitError(error)) return;
          if (!asToolbarZip) throw error;
          if (isSelectionTooLargeError(error)) return;
          toast.error(t('gallery.downloadError'));
        }
      } else {
        for (const photo of selectedPhotoList) {
          // A run that stalled and let go stops here: a click since then may
          // already have fetched the photos still to come.
          if (selectedRunRef.current?.id !== runId) break;
          // Marked like a tile's download (issue 2043): its buttons show it,
          // and a photo whose download is already being prepared is not
          // fetched a second time.
          const token = beginPhotoDownload(photo.id);
          if (token === null) continue;
          keepSelectedRunAlive(runId);
          try {
            await galleryService.downloadPhoto(slug, photo.id, photo.filename, () => {
              touchPhotoDownload(photo.id, token);
              keepSelectedRunAlive(runId);
            });
          } finally {
            endPhotoDownload(photo.id, token);
          }
        }
      }
    } finally {
      stillCurrent = selectedRunRef.current?.id === runId;
      releaseSelectedRun(runId);
    }
    // A run that stalled and let go may finish after a new selection was
    // made; that one is not cleared.
    if (!stillCurrent) return;

    // Clear selection after download
    setSelectedPhotos(new Set());
    setIsSelectionMode(false);
  };

  const handlePickerDownloaded = () => {
    if (!pickerForSelection) return;
    setSelectedPhotos(new Set());
    setIsSelectionMode(false);
  };

  // "Download these N" (#1074) — the payoff of the people filter.
  //
  // Deliberately NO new endpoint or person_id selector: the filtered photo
  // ids go through the same path as a manual selection, and the server
  // re-applies the access level and per-category permissions on the way
  // through. One less thing to authorize.
  //
  // Photos in a category with downloads disabled (#640) are excluded HERE as
  // well as server-side, so the number on the button is the number the guest
  // actually receives rather than an optimistic one.
  const peopleDownloadableIds = useMemo(() => {
    if (selectedPersonIds.length === 0) return [];
    return filteredPhotos
      .filter((photo) => photo.category_allow_downloads !== false)
      .map((photo) => photo.id);
  }, [filteredPhotos, selectedPersonIds]);

  const handleDownloadPeopleFiltered = async () => {
    if (!allowDownloads || peopleDownloadableIds.length === 0) return;
    if (refuseOverQuota(photosForIds(peopleDownloadableIds))) return;

    // Same resolution-picker behaviour as every other multi-photo download,
    // up to what one archive holds: the picker builds one archive, so a
    // larger set comes as several at the standard size instead of cut short.
    const inParts = peopleDownloadableIds.length > SELECTED_DOWNLOAD_LIMIT;
    if (downloadChoices.length > 1 && !inParts) {
      setResolutionPickerIds(peopleDownloadableIds);
      return;
    }

    analyticsService.trackGalleryEvent('bulk_download', {
      gallery: slug,
      photo_count: peopleDownloadableIds.length,
    });
    if (inParts) {
      toast.info(t('gallery.downloadingInParts', {
        count: peopleDownloadableIds.length,
        parts: splitIntoArchives(peopleDownloadableIds).length,
      }));
    }

    await galleryService.downloadPhotosInParts(slug, peopleDownloadableIds).catch((error) => {
      // The limit refusal already told the guest why (issue 1560).
      if (!isDownloadLimitError(error)) throw error;
    });
  };

  // Download just the open folder (#1160). The event-wide "download all" still
  // zips the whole gallery including foldered photos; this is the "only this
  // folder, once" case. Recursive since issue 1786: the folder and every
  // subfolder below it. Honours the per-category opt-out (#640), so a folder
  // with allow_downloads = false offers no button at all; a restriction on a
  // parent folder already reaches each photo's `category_allow_downloads`.
  const folderDownloadableIds = useMemo(() => {
    if (!openFolder) return [];
    if (openFolder.allow_downloads === false) return [];
    // The unfiltered subtree, not filteredPhotos: a search or feedback chip
    // stays active when entering a folder, and a button that says "Download
    // folder" must not quietly hand over a filtered subset of it (or vanish
    // when the filter matches nothing).
    return photosInSubtree(data?.photos, data?.categories, openFolder.id)
      .filter((photo) => photo.category_allow_downloads !== false)
      .map((photo) => photo.id);
  }, [openFolder, data?.photos, data?.categories]);

  // /download-selected caps the id list server-side, so a folder bigger than the
  // cap would deliver a truncated archive under a button promising the whole
  // thing. Send only what the server will honour, and say so on the label.
  // True when any category in this gallery opts out of downloads (#640).
  const hasRestrictedCategory = useMemo(
    () => (data?.categories || []).some((c) => c.allow_downloads === false),
    [data?.categories]
  );

  const folderDownloadIds = useMemo(
    () => folderDownloadableIds.slice(0, SELECTED_DOWNLOAD_LIMIT),
    [folderDownloadableIds]
  );
  const folderDownloadCapped = folderDownloadableIds.length > SELECTED_DOWNLOAD_LIMIT;

  const handleDownloadFolder = async () => {
    if (!allowDownloads || folderDownloadableIds.length === 0) return;
    if (refuseOverQuota(photosForIds(folderDownloadIds))) return;

    // Same resolution-picker behaviour as every other multi-photo download.
    if (downloadChoices.length > 1) {
      setResolutionPickerIds(folderDownloadIds);
      return;
    }

    analyticsService.trackGalleryEvent('bulk_download', {
      gallery: slug,
      photo_count: folderDownloadIds.length,
    });

    await galleryService.downloadSelectedPhotos(slug, folderDownloadIds).catch((error) => {
      // The limit refusal already told the guest why (issue 1560).
      if (!isDownloadLimitError(error)) throw error;
    });
  };

  // Calculate photo counts per category
  const photoCounts = useMemo(() => {
    const counts: Record<number | string, number> = {};
    // Scoped to the current view (#1160): a folder's photos must not inflate the
    // per-category counts shown at root, where those photos aren't in the grid.
    scopedPhotos
      .filter(photo => {
        if (mediaFilter === 'photo') return resolveMediaType(photo) !== 'video';
        if (mediaFilter === 'video') return resolveMediaType(photo) === 'video';
        return true;
      })
      .forEach(photo => {
      if (photo.category_id) {
        counts[photo.category_id] = (counts[photo.category_id] || 0) + 1;
      }
    });
    return counts;
  }, [scopedPhotos, mediaFilter]);

  // Track search usage with debouncing
  useEffect(() => {
    if (searchTerm.length > 0) {
      const timer = setTimeout(() => {
        analyticsService.trackSearch(searchTerm, filteredPhotos.length, 'gallery');
      }, 1000); // Debounce for 1 second

      return () => clearTimeout(timer);
    }
  }, [searchTerm, filteredPhotos.length]);

  // Track expiration warning views
  useEffect(() => {
    if (showUrgentWarning && daysUntilExpiration > 0) {
      analyticsService.trackExpirationWarning(slug, daysUntilExpiration);
    }
  }, [showUrgentWarning, daysUntilExpiration, slug]);

  if (isLoading || (isSwitchingClientMode && !showClientAccess)) {
    return <GallerySkeleton />;
  }

  // Auth failures end the session whenever they happen, background refetch
  // included. So does a gallery that is gone or closed to this guest (403,
  // 404, 410: expired, deleted, access withdrawn): keeping its grid would only
  // leave thumbnails that fail one by one. Any other failure replaces the
  // gallery only when nothing has loaded yet: a failed background refetch
  // keeps the photos on screen (TanStack keeps `data` and sets `error`), as
  // UX.md › States asks.
  const errorStatus = (error as { response?: { status?: number } } | null)?.response?.status;
  const galleryGone = errorStatus === 403 || errorStatus === 404 || errorStatus === 410;
  if (error) {
    // Check if it's an authentication error (401)
    const is401Error = (error as any)?.response?.status === 401;

    // An admin preview whose admin session idled out: offer to sign in again.
    // Logging a guest session out would leave the preview blank.
    if (isAdminSessionExpired(error)) {
      return <PasswordChangeRequiredNotice reason="session" />;
    }

    if (is401Error) {
      // Authentication failed - end the session and let the parent component
      // handle re-authentication. Not logout(): that also drops the guest
      // identity, which outlives this session by design (issue 2209).
      endSession();
      return null;
    }

    if (isPasswordChangeRequired(error)) {
      return <PasswordChangeRequiredNotice />;
    }
  }

  if (!data || galleryGone) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-4">
        <div className="text-center" role="alert">
          <AlertCircle className="w-10 h-10 mx-auto mb-3 text-muted-theme" aria-hidden="true" />
          <p className="text-lg text-muted-theme">{t('gallery.failedToLoad')}</p>
          <Button onClick={() => refetch()} className="mt-4">
            {t('gallery.tryAgain')}
          </Button>
        </div>
      </div>
    );
  }

  const adminPreview = new URLSearchParams(window.location.search).get('admin_preview') === '1';
  const onManageGallery = !adminPreview && (viaClientPin || (!isClient && data.event.client_pin_entry_available)) ? async () => {
    if (isClient) {
      try { await leaveClientMode(slug); }
      catch { toast.error(t('clientAccess.returnFailed', 'Could not return to the gallery. Please try again.')); }
    } else {
      setSidebarOpen(false);
      setShowClientAccess(true);
    }
  } : undefined;
  const clientAccessControl = onManageGallery ? (
    <Button variant="outline" size="sm" leftIcon={<Shield className="w-4 h-4" />} className="gallery-btn"
      onClick={onManageGallery} disabled={isSwitchingClientMode}>
      {isClient ? t('clientAccess.returnToGallery', 'Return to gallery') : t('clientAccess.manageGallery', 'Manage Gallery')}
    </Button>
  ) : null;
  const clientAccessDialog = showClientAccess ? (
    <GalleryClientAccessDialog onClose={() => setShowClientAccess(false)} onSubmit={async (pin) => {
      await enterClientMode(slug, pin);
      setShowClientAccess(false);
    }} />
  ) : null;

  // Determine controls style (sidebar vs classic inline filter bar).
  // Decoupled from layout — only an explicit controlsStyle === 'sidebar' on
  // the theme renders the sidebar. Default (unset or 'classic') is the inline
  // filter bar for every layout, so the gallery header/filters look identical
  // regardless of whether the photos render as grid, masonry, carousel, etc.
  const headerStyle = data?.event?.header_style || theme.headerStyle || 'standard';
  const isHeroHeader = headerStyle === 'hero';
  const showSidebar = theme.controlsStyle === 'sidebar';
  const filterBarShown = !showSidebar
    && settingsData?.gallery_show_filter_bar !== false
    // Scoped (#1160): on a folder-only root there is nothing for search, sort or
    // the feedback chips to act on, and showing them reintroduces exactly the
    // empty filter row discussion #317 complained about.
    && scopedPhotos.length > 0;
  // Picking photos one by one (issue 1733, E8): not in a carousel, and not for
  // a single photo, as the grid's own toolbar had it.
  const selectionAvailable = filteredPhotos.length > 1 && theme.galleryLayout !== 'carousel';
  // The sidebar carries every one of these controls itself.
  const toolbarShown = !showSidebar
    && (filterBarShown || selectionAvailable || isSelectionMode || selectedPhotos.size > 0 || copyFilenames.photos.length > 0);
  const creditPanelShown = creditsVisible && creditGroups(scopedPhotos).length > 0;
  const hasPanelFilters = feedbackEnabled || showMediaFilter || creditPanelShown || tagChips.length > 0;
  // The viewer's saved tile size (issue 1733, E4) applies only where a
  // control puts the switch on screen to change it back: the toolbar or the
  // sidebar. A Carousel gets no switch, so its delivery placeholders keep the
  // theme size.
  const densityOffered = (toolbarShown || showSidebar) && layoutHasDensity(theme.galleryLayout);

  // Reveal mode (#838): the server returned the event shell with no photos —
  // render the upload-only view for EVERY layout. Enforcement is server-side
  // (the photo endpoints refuse plain guests); this is the friendly face.
  if (hiddenUntilReveal) {
    return (
      <PhotoDownloadChoiceProvider {...downloadChoiceProps}>
      <GalleryLayout
        event={{
          ...event,
          // The reveal-hidden view still renders the chrome, so BOTH
          // banners resolve here too. The context `event` comes from the
          // gallery login response and carries no banner fields, which would
          // silently downgrade a per-event 'off' to 'inherit' and show the
          // global banner on a gallery the admin muted (#440 promo / #932 info).
          promo_mode: (data?.event as { promo_mode?: 'inherit' | 'custom' | 'off' })?.promo_mode,
          promo_markdown: (data?.event as { promo_markdown?: string | null })?.promo_markdown,
          info_mode: (data?.event as { info_mode?: 'inherit' | 'custom' | 'off' })?.info_mode,
          info_markdown: (data?.event as { info_markdown?: string | null })?.info_markdown,
        }}
        brandingSettings={brandingSettings}
        headerExtra={clientAccessControl}
      >
        {clientAccessDialog}
        <div className="max-w-xl mx-auto text-center py-16 px-4">
          <div className="mx-auto mb-5 w-16 h-16 rounded-full bg-surface flex items-center justify-center">
            <EyeOff className="w-8 h-8 text-muted-theme" />
          </div>
          <h2 className="text-2xl font-semibold mb-3" style={{ color: 'var(--color-text, #171717)' }}>
            {t('gallery.revealPendingTitle', 'The photos are still a surprise')}
          </h2>
          <p className="text-muted-theme mb-2">
            {t('gallery.revealPendingMessage', 'The host will reveal the gallery later — check back soon!')}
          </p>
          {data.reveal_at && (
            <p className="text-sm text-muted-theme mb-6">
              {t('gallery.revealScheduledFor', 'Reveal scheduled for {{date}}', {
                date: formatDateTime(data.reveal_at),
              })}
            </p>
          )}
          {allowUploads && (
            <div className="mt-6">
              <p className="text-sm text-muted-theme mb-3">
                {t('gallery.revealUploadHint', 'You can already add your own photos to the collection:')}
              </p>
              <Button
                variant="primary"
                size="lg"
                leftIcon={<Upload className="w-5 h-5" />}
                onClick={() => setShowUploadModal(true)}
              >
                {t('upload.uploadPhotos', 'Upload Photos')}
              </Button>
            </div>
          )}
        </div>
        {showUploadModal && allowUploads && (
          <UserPhotoUpload
            eventId={data?.event?.id || event?.id}
            categoryId={data?.event?.upload_category_id || event?.upload_category_id}
            {...uploaderNameProps}
            onUploadComplete={() => setShowUploadModal(false)}
            onClose={() => setShowUploadModal(false)}
          />
        )}

        {/* Download size picker (#858) — "download all", or a selection. */}
        {(showResolutionPicker || resolutionPickerIds || resumeJobToken) && (
          <DownloadResolutionModal
            slug={slug}
            choices={downloadChoices}
            standardResolution={data?.event?.download_resolution?.standard}
            photoIds={resolutionPickerIds || undefined}
            quotaPhotos={resolutionPickerIds ? photosForIds(resolutionPickerIds) : allDownloadablePhotos}
            resumeToken={resumeJobToken || undefined}
            onDownloaded={handlePickerDownloaded}
            onClose={() => {
              setShowResolutionPicker(false);
              setResolutionPickerIds(null);
              setPickerForSelection(false);
              setResumeJobToken(null);
              clearDownloadJobParam();
            }}
          />
        )}
      </GalleryLayout>
      </PhotoDownloadChoiceProvider>
    );
  }

  // Full-page layouts (gallery-premium, gallery-story) have their own integrated UI
  // Skip all wrapper elements (header, footer, sidebar, filters) for these layouts
  const isFullPageLayout = theme.galleryLayout === 'gallery-premium' || theme.galleryLayout === 'gallery-story';

  // Does this session hold something worth dropping? A password gallery and a
  // PIN client obviously do. So does a customer-portal session: its token
  // bypasses reveal mode, so it opens galleries a plain visitor cannot, and it
  // lives for 24h in a cookie the customer logout does not clear. Hiding the
  // control would remove the only way to drop it (#1149).
  //
  // Read from the auth context, which resolves this from /auth/session on
  // mount — NOT from the photos payload. That response is cached by React
  // Query for five minutes on a key that knows nothing about the session, so
  // opening a gallery as a guest and then from the portal would have reused
  // the guest answer, and vice versa.
  const showLogoutControl = requiresPassword || isClient || viaCustomer;

  // Folder navigation (#1160, nested since issue 1786): the view switch, a
  // breadcrumb, the tiles of the current level's subfolders and, inside a
  // folder, its (recursive) download. Defined once and rendered by BOTH layout
  // branches — containment comes from `filteredPhotos`, which every branch
  // uses, so a branch that hides foldered photos without offering the tiles
  // makes them unreachable. Renders nothing at all when the gallery has no
  // folders, so galleries that don't use the feature are untouched.
  const folderDownloadButton = openFolder && allowDownloads && folderDownloadableIds.length > 0 ? (
    <Button
      variant="outline"
      size="sm"
      onClick={handleDownloadFolder}
      leftIcon={<Download className="w-4 h-4" />}
    >
      {folderDownloadCapped
        ? t('gallery.downloadFolderCapped', 'Download first {{limit}} of {{total}}', {
            limit: SELECTED_DOWNLOAD_LIMIT,
            total: folderDownloadableIds.length,
          })
        : tiles.length > 0
          ? t('gallery.downloadFolderWithSubfolders', 'Download folder incl. subfolders ({{count}})', {
              count: folderDownloadableIds.length,
            })
          : t('gallery.downloadFolder', 'Download folder ({{count}})', {
              count: folderDownloadableIds.length,
            })}
    </Button>
  ) : null;

  const buildFolderNav = (compact: boolean) => hasFolders ? (
    // GalleryFolderTiles brings its own bottom margin.
    <div className={compact ? 'flex flex-col gap-3' : tiles.length > 0 ? '' : 'mb-6'}>
      <div className={`flex flex-wrap items-center gap-3 ${compact || tiles.length === 0 ? '' : 'mb-6'}`}>
        {/* On a phone the switch gets its own full-width row on top, as in
            the issue 1786 mockup; from sm up it sits at the right. */}
        <GalleryViewSwitch
          view={viewAll ? 'all' : 'folders'}
          onChange={changeGalleryView}
          className={compact ? 'sm:order-last' : 'order-first w-full sm:w-auto sm:order-last sm:ml-auto'}
        />
        {!viewAll && (
          <GalleryBreadcrumb trail={folderTrail} onNavigate={openFolderBySlug} className="min-w-0 basis-full sm:basis-0 sm:flex-1" />
        )}
        {folderDownloadButton}
      </div>
      {!viewAll && (
        <GalleryFolderTiles
          tiles={tiles}
          onOpen={openFolderBySlug}
          compact={compact}
          slug={slug}
          useEnhancedProtection={protectionLevel !== 'basic'}
          allowDownloads={allowDownloads}
        />
      )}
    </div>
  ) : null;

  const folderNav = buildFolderNav(false);

  // True only when there is something to show, so the full-page layouts keep
  // their edge-to-edge hero untouched unless folders are actually in use.
  const hasFolderNav = hasFolders;

  // A level where every photo lives in a subfolder (a folder-only root, or a
  // "Saturday" that only holds activities): the tiles ARE the content, and the
  // grid below them would otherwise render its empty state. Deliberately
  // `scopedPhotos`, not `filteredPhotos`: with loose photos present, a search
  // matching none of them would otherwise look "folder-only" and swallow the
  // no-results message the guest needs.
  const rootIsFoldersOnly = !viewAll && tiles.length > 0 && scopedPhotos.length === 0;

  // Two-stage delivery (issue 1562): banner + placeholders after the
  // delivered photos, at the root and in "All photos" — not inside a folder,
  // where "more photos are coming" would read as "more for this folder".
  const showDeliveryBanner = delivery?.status === 'partial' && !openFolder;
  const gridKey = viewAll ? 'all' : openFolder ? `folder-${openFolder.id}` : 'root';

  // For full-page layouts, render just the PhotoGridWithLayouts without any wrappers
  const identityMode: 'simple' | 'guest' =
    feedbackSettings?.identity_mode === 'guest' ? 'guest' : 'simple';

  if (isFullPageLayout) {
    return (
      // The same identity flow as the standard layout below (issue 1733):
      // Premium and Story already ask for it (ensureIdentity) before a like,
      // and finishing a selection needs it too. Without the provider a guest
      // in guest identity mode was never asked for a name and got a 401.
      <GuestIdentityProvider slug={slug} identityMode={identityMode}>
      <DownloadQuotaProvider slug={slug} event={data?.event}>
      <PhotoDownloadChoiceProvider {...downloadChoiceProps}>
      <GalleryTileBadgesProvider value={tileBadges}>
      <PhotoLabelsProvider neutral={neutralPhotoLabels} photos={filteredPhotos}>
        <GuestNamePromptModal requireEmail={!!feedbackSettings?.require_name_email} />
        <GuestRecoveryModal />
        {/* #1160: these layouts return early and render edge-to-edge, but they
            still get `filteredPhotos`, so without this the foldered photos
            would be hidden with no way in. Contained width so the folder strip
            reads as chrome against the full-bleed grid below it. */}
        {(hasFolderNav || selectionBarShown || (copyFilenames.photos.length > 0 && theme.galleryLayout !== 'gallery-story')) && (
          // Story's `.story-nav` is fixed across this same band at z-index 50.
          // Raising the strip above it is necessary for the chips to be
          // clickable at all, but the strip is mostly empty space — so the
          // container itself must not take hits, or it would block the nav's own
          // search/favourites/logout underneath. Only the real controls opt back
          // in via pointer-events-auto.
          // With the selection bar (issue 1733) the band starts below that
          // nav in Story: the bar is wider than the gap the nav leaves, and on
          // a phone it would cover the nav's logout and favourites.
          <div className={`relative z-[60] pointer-events-none max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-3 flex-wrap ${
            selectionBarShown && theme.galleryLayout === 'gallery-story' ? 'pt-20' : ''
          }`}>
            {hasFolderNav && (
              <div className="pointer-events-auto flex items-center gap-3 flex-wrap">
                {buildFolderNav(true)}
              </div>
            )}
            {/* Hidden when a category opts out of downloads (#640): this routes
                to the whole-gallery zip, which contains every event photo with
                no per-category filter, so offering it here would hand a guest
                the photos that opt-out is meant to withhold. Those galleries
                keep the per-folder download, which enforces it.

                These layouts have no header download button — their only
                gallery-wide download is select-all + download-selected, and
                select-all is (correctly) scoped to what is on screen. Once
                folders exist that leaves no single way to get everything, so
                surface the event-wide zip here. Root only: inside a folder the
                breadcrumb already offers that folder's download. */}
            {hasFolderNav && !openFolder && allowDownloads && !hasRestrictedCategory && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadAll}
                disabled={downloadAllMutation.isPending || !downloadQuota.allows(allDownloadablePhotos)}
                leftIcon={<Download className="w-4 h-4" />}
                // No ml-auto: the right of this band belongs to Story's fixed
                // nav (logout, favourites), and pushing the button over there
                // physically covers those controls.
                className="pointer-events-auto"
              >
                {t('gallery.downloadEverything', 'Download all photos')}
              </Button>
            )}
            {/* Filename list (issue 1733, A3d). Premium has no selection
                toolbar and no sidebar, so this band is the only chrome of ours
                above its full-bleed grid. Story's fixed nav covers this band
                on narrow phones, so Story gets the button inside that nav
                instead (onCopyFilenames below). */}
            {copyFilenames.photos.length > 0 && theme.galleryLayout !== 'gallery-story' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCopyFilenames(true)}
                leftIcon={<ClipboardList className="w-4 h-4" />}
                className="pointer-events-auto"
              >
                {t('gallery.copyFilenames.button', 'Copy filenames')} ({copyFilenames.photos.length})
              </Button>
            )}
            {/* Counter and hand-over (issue 1733, A1): the same band, for the
                reason given above. */}
            <SelectionSubmitBar
              slug={slug}
              state={selectionState}
              used={selectionUsed}
              requireNameEmail={!!feedbackSettings?.require_name_email}
              sharedIdentity={feedbackSettings?.identity_mode === 'shared'}
              className="pointer-events-auto"
            />
          </div>
        )}
        <PhotoGridWithLayouts
          // Remount on a scope change (#1160): layout state such as the
          // carousel's currentIndex is only meaningful for the photo set it was
          // built against, and an index kept from a larger scope indexes past
          // the end of a smaller folder.
          key={gridKey}
          photos={filteredPhotos}
          openPhotoId={linkedPhotoId}
          onLightboxPhotoChange={handleLightboxPhotoChange}
          // Banner only: these layouts tile photos in their own geometry, which
          // a plain grid of placeholders would not match (issue 1562).
          afterGrid={showDeliveryBanner
            ? <GalleryDeliveryBanner delivery={delivery} showPlaceholders={false} />
            : undefined}
          // The hero, title, logout and download controls live inside this
          // component for the full-bleed layouts, so a folder-only root must
          // silence the empty message without unmounting the shell (#1160).
          suppressEmptyState={rootIsFoldersOnly}
          emptyIsFiltered={emptyIsFiltered}
          // Event-wide, so a layout's own Download All neither skips foldered
          // photos nor truncates at the 500-id cap (#1160).
          eventPhotoCount={data?.photos?.length || 0}
          // Withheld when any category opts out of downloads (#640): the
          // whole-gallery route serves a prebuilt zip that contains EVERY event
          // photo with no per-category filter (gallery.js's own note on
          // bumpEventDownloadCounts). Handing this to the layout there would
          // turn a restricted photo into a downloadable one, so those galleries
          // keep the id-based path, which enforces the opt-out.
          onDownloadEverything={
            allowDownloads && !hasRestrictedCategory ? handleDownloadAll : undefined
          }
          onCopyFilenames={() => setShowCopyFilenames(true)}
          copyFilenamesCount={copyFilenames.photos.length}
          // The nav heart: the gallery's own "Liked" filter, so the lightbox,
          // select-all and download-selected all see the same list.
          likedOnly={activeFilters.includes('liked')}
          onToggleLikedOnly={() => handleFilterChange('liked')}
          slug={slug}
          people={peopleEnabled ? people : undefined}
          onSelectPerson={togglePerson}
          categoryId={selectedCategoryId}
          onFeedbackChange={handleFeedbackChange}
          heroPhotoOverride={staticHeroPhoto}
          feedbackEnabled={feedbackEnabled}
          feedbackOptions={{
            allowLikes: !!feedbackSettings?.allow_likes,
            allowFavorites: !!feedbackSettings?.allow_favorites,
            allowRatings: !!feedbackSettings?.allow_ratings,
            allowComments: !!feedbackSettings?.allow_comments,
            allowReactions: !!feedbackSettings?.allow_reactions,
            requireNameEmail: !!feedbackSettings?.require_name_email,
          }}
          isSelectionMode={isSelectionMode}
          selectedPhotos={selectedPhotos}
          onSelectionChange={setSelectedPhotos}
          photosForIds={photosForIds}
          onToggleSelectionMode={() => setIsSelectionMode(!isSelectionMode)}
          eventName={event.event_name}
          eventLogo={data?.event?.hero_logo_url || brandingSettings?.logo_url}
          eventDate={event.event_date}
          expiresAt={event.expires_at}
          allowDownloads={allowDownloads}
          downloadChoices={downloadChoices}
          downloadStandard={data?.event?.download_resolution?.standard}
          protectionLevel={protectionLevel}
          useEnhancedProtection={protectionLevel !== 'basic'}
          disableRightClick={disableRightClick}
          enableDevtoolsProtection={enableDevtoolsProtection}
          useCanvasRendering={useCanvasRendering}
          heroLogoVisible={data?.event?.hero_logo_visible !== false}
          heroLogoSize={data?.event?.hero_logo_size || 'medium'}
          heroLogoPosition={data?.event?.hero_logo_position || 'top'}
          headerStyle={data?.event?.header_style || theme.headerStyle}
          heroDividerStyle={data?.event?.hero_divider_style || theme.heroDividerStyle || 'wave'}
          heroImageAnchor={data?.event?.hero_image_anchor || 'center'}
          welcomeMessage={event.welcome_message}
          // Same gate as the standard layout below (#1149). These layouts
          // render the button on the callback being present rather than on a
          // showLogout flag, so withholding it is how the gate reaches them.
          onLogout={showLogoutControl ? logout : undefined}
          onManageGallery={onManageGallery}
          clientModeBusy={isSwitchingClientMode}
          // Client access (issue 1992): the full-page layouts render the eye
          // toggle too, so they need the same props as the standard branch.
          isClient={isClient}
          onToggleVisibility={isClient ? handleToggleVisibility : undefined}
          // These layouts skip the GalleryLayout header, the only place the
          // standard layouts offer the upload button, so they render their
          // own from this callback; same gate as that header button.
          onUploadClick={
            allowUploads
              ? () => setShowUploadModal(true)
              : undefined
          }
          showOriginalFilename={showOriginalFilename}
        />

        {clientAccessDialog}

        {/* Upload Modal for full-page layouts */}
        {showUploadModal && allowUploads && (
          <UserPhotoUpload
            eventId={data?.event?.id || event?.id}
            categoryId={data?.event?.upload_category_id || event?.upload_category_id}
            {...uploaderNameProps}
            onUploadComplete={handleUploadComplete}
            onClose={() => setShowUploadModal(false)}
          />
        )}
        {uploadProcessingNotice}
        {newPhotosPill}

        {/* Download size picker (#858) — "download all", or a selection. */}
        {(showResolutionPicker || resolutionPickerIds || resumeJobToken) && (
          <DownloadResolutionModal
            slug={slug}
            choices={downloadChoices}
            standardResolution={data?.event?.download_resolution?.standard}
            photoIds={resolutionPickerIds || undefined}
            quotaPhotos={resolutionPickerIds ? photosForIds(resolutionPickerIds) : allDownloadablePhotos}
            resumeToken={resumeJobToken || undefined}
            onDownloaded={handlePickerDownloaded}
            onClose={() => {
              setShowResolutionPicker(false);
              setResolutionPickerIds(null);
              setPickerForSelection(false);
              setResumeJobToken(null);
              clearDownloadJobParam();
            }}
          />
        )}

        {(isClient || viaCustomer) && <GalleryProductPanel slug={slug} />}

        {/* Filename list for a RAW editor search (issue 1733, A3d). */}
        {showCopyFilenames && (
          <CopyFilenamesDialog
            photos={copyFilenames.photos}
            source={copyFilenames.source}
            onClose={() => setShowCopyFilenames(false)}
          />
        )}
      </PhotoLabelsProvider>
      </GalleryTileBadgesProvider>
      </PhotoDownloadChoiceProvider>
      </DownloadQuotaProvider>
      </GuestIdentityProvider>
    );
  }

  return (
    <GuestIdentityProvider slug={slug} identityMode={identityMode}>
    <DownloadQuotaProvider slug={slug} event={data?.event}>
      <PhotoDownloadChoiceProvider {...downloadChoiceProps}>
      <GalleryTileBadgesProvider value={tileBadges}>
      <PhotoLabelsProvider neutral={neutralPhotoLabels} photos={filteredPhotos}>
      <GridDensityOffered.Provider value={densityOffered}>
      <GuestNamePromptModal requireEmail={!!feedbackSettings?.require_name_email} />
      <GuestRecoveryModal />
      {/* Sidebar for non-grid layouts */}
      {showSidebar ? (
        <GallerySidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(!sidebarOpen)}
          returnFocusRef={sidebarToggleRef}
          clientAccessControl={clientAccessControl}
          categories={filterCategories(data?.categories).filter(cat => photoCounts[cat.id] > 0)}
          selectedCategoryId={selectedCategoryId}
          onCategoryChange={setSelectedCategoryId}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          sortBy={sortBy}
          onSortChange={setSortBy}
          sortDesc={sortDesc}
          onSortDescChange={setSortDesc}
          isSelectionMode={isSelectionMode}
          onToggleSelectionMode={() => setIsSelectionMode(!isSelectionMode)}
          hasVideos={hasVideoItems(scopedPhotos)}
          selectedCount={selectedPhotos.size}
          onSelectAll={selectAllVisible}
          onDeselectAll={deselectAll}
          visibleCount={filteredPhotos.length}
          onDownloadAll={handleDownloadAll}
          onDownloadSelected={handleDownloadSelected}
          isDownloading={downloadAllMutation.isPending}
          isDownloadingSelected={downloadingSelected}
          allowDownloads={allowDownloads}
          photoCounts={photoCounts}
          totalPhotos={scopedPhotos.length}
          // Download All hits /download-all, which is event-wide — labelling or
          // disabling it from the scoped count would show 0 on a folder-only
          // root and refuse a perfectly valid download (#1160).
          downloadAllTotal={data?.photos?.length || 0}
          downloadAllPhotos={allDownloadablePhotos}
          selectedPhotosForQuota={downloadQuota.limited ? photosForIds(Array.from(selectedPhotos)) : undefined}
          isMobile={isMobile}
          galleryLayout={theme.galleryLayout}
          allowUploads={allowUploads}
          onUploadClick={() => setShowUploadModal(true)}
          feedbackEnabled={feedbackEnabled}
          activeFilters={activeFilters}
          onFilterChange={handleFilterChange}
          mediaFilter={mediaFilter}
          onMediaFilterChange={setMediaFilter}
          showMediaFilter={showMediaFilter}
          likeCount={likeCount}
          favoriteCount={favoriteCount}
          ratedCount={ratedCount}
          colorLabelsEnabled={!!feedbackSettings?.allow_color_labels}
          activeColorFilters={activeColorFilters}
          onColorFilterChange={handleColorFilterToggle}
          colorLabelCounts={colorLabelCounts}
          ratingsEnabled={!!feedbackSettings?.allow_ratings}
          minRating={minRating}
          onMinRatingChange={setMinRating}
          minRatingCounts={minRatingCounts}
          bulkRating={feedbackEnabled && feedbackSettings?.allow_ratings ? {
            slug,
            photoIds: Array.from(selectedPhotos),
            requireNameEmail: !!feedbackSettings?.require_name_email,
          } : undefined}
          creditPhotos={creditsVisible ? scopedPhotos : undefined}
          selectedCreditKey={selectedCreditKey}
          onCreditChange={setSelectedCreditKey}
          tagChips={tagChips}
          selectedTagKeys={selectedTagKeys}
          onTagToggle={toggleTag}
          onCopyFilenames={() => setShowCopyFilenames(true)}
          copyFilenamesCount={copyFilenames.photos.length}
          selectedPhotoList={selectedPhotoList}
          onDeselectPhoto={deselectPhoto}
          slug={slug}
          folderTree={hasFolders ? {
            nodes: sidebarFolderTree,
            openPath: folderTrail.map((folder) => folder.id),
            view: viewAll ? 'all' : 'folders',
            onOpenFolder: openFolderBySlug,
            onViewChange: changeGalleryView,
            rootCount: rootPhotoCount,
            totalCount: data?.photos?.length || 0,
          } : undefined}
        />
      ) : null}

      <GalleryLayout
        event={{
          ...event,
          // Per-event promo override (#440).
          promo_mode: (data?.event as { promo_mode?: 'inherit' | 'custom' | 'off' })?.promo_mode,
          promo_markdown: (data?.event as { promo_markdown?: string | null })?.promo_markdown,
          // Per-event info-banner override (#932). Read from the /photos
          // response rather than the context event: the context is seeded from
          // the gallery LOGIN response, which carries only a small identity
          // subset, so anything not in that subset is undefined right after a
          // guest signs in. /photos is the payload that refreshes on every
          // gallery load, which is why the fields were added there too.
          info_mode: (data?.event as { info_mode?: 'inherit' | 'custom' | 'off' })?.info_mode,
          info_markdown: (data?.event as { info_markdown?: string | null })?.info_markdown,
        }}
        brandingSettings={brandingSettings}
        heroLogoVisible={data?.event?.hero_logo_visible !== false}
        heroLogoSize={data?.event?.hero_logo_size || undefined}
        headerStyle={data?.event?.header_style || theme.headerStyle}
        showLogout={showLogoutControl}
        onLogout={logout}
        // Old Download All header button is replaced by the new
        // showHeaderDownload below — accent-coloured, always visible when
        // downloads are allowed, sits right before Logout (#386).
        showDownloadAll={false}
        onDownloadAll={handleDownloadAll}
        isDownloading={downloadAllMutation.isPending}
        menuButton={
          // Menu icon is shown when the event theme uses the sidebar
          // controls style. The button is icon-only — the redundant
          // "Menu" text label was dropped (#386). The wrapper aligns the
          // icon to the very left of the header so the logo lines up
          // with the leftmost gallery image.
          showSidebar ? (
            <Button
              ref={sidebarToggleRef}
              variant="ghost"
              size="sm"
              className="gallery-btn p-2"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label={t('gallery.toggleMenu')}
            >
              <Menu className="w-5 h-5" />
            </Button>
          ) : undefined
        }
        // Nothing to download in a loaded, empty gallery (an admin preview of
        // a draft, issue 2088); while it loads the button stays as it was.
        showHeaderDownload={allowDownloads && !(data && (data.photos?.length ?? 0) === 0)}
        onHeaderDownload={handleDownloadAll}
        headerExtra={(() => {
          const items = [];
          if (!showSidebar && clientAccessControl) items.push(<React.Fragment key="client-access">{clientAccessControl}</React.Fragment>);
          
          if (daysUntilExpiration !== null && daysUntilExpiration <= 1 && daysUntilExpiration > 0 && event.expires_at) {
            items.push(
              <CountdownTimer key="countdown" expiresAt={event.expires_at} className="mr-2" />
            );
          }
          
          // Upload button - always show when uploads are allowed (regardless of layout/theme loading state)
          if (allowUploads) {
            items.push(
              <Button
                key="upload-button"
                variant="outline"
                size="sm"
                leftIcon={<Upload className="w-4 h-4" />}
                onClick={() => setShowUploadModal(true)}
                className={!showSidebar ? 'flex-1 sm:flex-initial' : ''}
              >
                <span className="hidden sm:inline">{t('upload.uploadPhotos')}</span>
                <span className="sm:hidden">{t('common.upload')}</span>
              </Button>
            );
          }
          
          return items.length > 0 ? <>{items}</> : null;
        })()}
      >
        {clientAccessDialog}
        {(isClient || viaCustomer) && <GalleryProductPanel slug={slug} />}
        {/* Expiration Banner */}
        {showUrgentWarning && event.expires_at && (
          <ExpirationBanner daysRemaining={daysUntilExpiration} expiresAt={event.expires_at} />
        )}

        {/* "x of y selected", Finish selection, Approve edited photos
            (issue 1733, A1). */}
        <SelectionSubmitBar
          slug={slug}
          state={selectionState}
          used={selectionUsed}
          requireNameEmail={!!feedbackSettings?.require_name_email}
          sharedIdentity={feedbackSettings?.identity_mode === 'shared'}
          className="mt-4"
        />

        {/* Client Access Banner (#172) */}
        {isClient && (
          <div className="mt-4 rounded-lg status-chip hue-warning p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5" />
                <span className="text-sm font-medium">
                  {t('clientAccess.banner')}
                </span>
                <span className="text-xs ml-2">
                  {t('clientAccess.visibleCount', { visible: visibleCount, total: totalCount })}
                </span>
              </div>
              {isSelectionMode && selectedPhotos.size > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<EyeOff className="w-4 h-4" />}
                    onClick={() => handleBulkVisibility('hidden')}
                  >
                    {t('clientAccess.hideSelected')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<Eye className="w-4 h-4" />}
                    onClick={() => handleBulkVisibility('visible')}
                  >
                    {t('clientAccess.showSelected')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* The gallery toolbar (issue 1733, E8): search, filters, sort and
            Select while browsing, the batch actions once anything is
            selected. Sticky, so both stay one tap away down the grid. Search,
            sort and filters only when the admin enables the filter bar and
            the gallery actually has photos (avoids the empty "Search photos
            by filename" row from discussion #317). */}
        {toolbarShown ? (
          <GalleryToolbar
            className="mt-3"
            search={filterBarShown ? { value: searchTerm, onChange: setSearchTerm } : undefined}
            sort={filterBarShown ? { sortBy, onSortChange: setSortBy, sortDesc, onSortDescChange: setSortDesc } : undefined}
            // While selecting, the panel also carries the search box the bar
            // gives up, so it opens even where there is nothing else to filter.
            filters={filterBarShown && (hasPanelFilters || isSelectionMode || selectedPhotos.size > 0) ? {
              activeCount: activePanelFilterCount,
              render: (close, withSearch) => (
                <GalleryFilterPanel
                  search={withSearch ? { value: searchTerm, onChange: setSearchTerm } : undefined}
                  feedback={feedbackEnabled ? { activeFilters, onFilterChange: handleFilterChange } : undefined}
                  colorLabels={feedbackEnabled && feedbackSettings?.allow_color_labels ? {
                    activeColors: activeColorFilters,
                    onToggle: handleColorFilterToggle,
                    counts: colorLabelCounts,
                  } : undefined}
                  minRating={feedbackEnabled && feedbackSettings?.allow_ratings ? {
                    value: minRating,
                    onChange: setMinRating,
                    counts: minRatingCounts,
                  } : undefined}
                  media={showMediaFilter ? { value: mediaFilter, onChange: setMediaFilter } : undefined}
                  // Scoped, so a chip can't advertise a count the grid won't produce.
                  credits={creditPanelShown ? { photos: scopedPhotos, selectedKey: selectedCreditKey, onChange: setSelectedCreditKey } : undefined}
                  tags={tagChips.length > 0 ? { tags: tagChips, selectedKeys: selectedTagKeys, onToggle: toggleTag } : undefined}
                  matchCount={filteredPhotos.length}
                  hasVideos={hasVideoItems(filteredPhotos)}
                  filtersActive={activePanelFilterCount > 0}
                  onClearFilters={clearPanelFilters}
                  onSelectMatches={selectionAvailable ? () => {
                    selectFiltered();
                    close();
                  } : undefined}
                />
              ),
            } : undefined}
            viewControls={<GridDensityControl layout={theme.galleryLayout} />}
            photoCount={filterBarShown ? filteredPhotos.length : undefined}
            copyFilenames={{ count: copyFilenames.photos.length, onClick: () => setShowCopyFilenames(true) }}
            selection={{
              available: selectionAvailable,
              hasVideos: hasVideoItems(filteredPhotos),
              isSelectionMode,
              selectedCount: selectedPhotos.size,
              visibleCount: filteredPhotos.length,
              onStart: () => setIsSelectionMode(true),
              onCancel: cancelSelection,
              onSelectAll: selectAllVisible,
              onDeselectAll: deselectAll,
              download: allowDownloads ? {
                onClick: handleDownloadSelected,
                disabled: !downloadQuota.allows(selectedQuotaPhotos),
                isLoading: downloadingSelected,
                quotaPhotos: selectedQuotaPhotos,
              } : undefined,
              bulkRating: feedbackEnabled && feedbackSettings?.allow_ratings ? {
                slug,
                photoIds: Array.from(selectedPhotos),
                requireNameEmail: !!feedbackSettings?.require_name_email,
              } : undefined,
              tray: { photos: selectedPhotoList, onRemove: deselectPhoto, slug },
            }}
          />
        ) : null}

        {/* Categories stay on the page, under the toolbar: they are how a
            guest finds "the ceremony". Folders are navigation, not a filter
            (#1160) — they get tiles. Since issue 1786 a photo's folder and its
            filter category are separate fields, so the chips work inside a
            folder and in "All photos" too. */}
        {filterBarShown && (
          <GalleryCategoryChips
            className="mt-4"
            categories={filterCategories(data.categories)}
            photos={scopedPhotos}
            selectedCategoryId={selectedCategoryId}
            onCategoryChange={setSelectedCategoryId}
            hasVideos={showMediaFilter}
          />
        )}

        {/* People in this gallery (#1074). Sits between the filter bar and
            the grid. Renders nothing at all unless the photographer enabled
            detection AND left it visible to guests — people_enabled carries
            both decisions plus the global feature flag. */}
        {peopleEnabled && (
          <div className="mt-4">
            <PeopleStrip
              people={people}
              photos={scopedPhotos}
              slug={slug}
              selectedPersonIds={selectedPersonIds}
              onToggle={togglePerson}
              onShowAll={() => setShowPeopleSheet(true)}
              scan={peopleData?.scan}
              collapsed={peopleCollapsed}
              onCollapsedChange={handlePeopleCollapsedChange}
            />

            {/* Active people filter. The chip row is the single place the
                current selection is stated, so "why am I seeing 97 photos"
                is always answerable at a glance. */}
            {selectedPersonIds.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-2 py-2 border-t"
                style={{ borderColor: 'var(--color-surface-border)' }}
              >
                {selectedPersonIds.map((id) => {
                  const person = people.find((p) => p.id === id);
                  if (!person) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => togglePerson(id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent-soft text-theme text-sm hover:brightness-95"
                    >
                      {person.label || t('gallery.people.unnamedCount', {
                        count: person.face_count,
                        defaultValue: `${person.face_count} photos`,
                      })}
                      <X size={14} />
                    </button>
                  );
                })}

                {/* Only meaningful with two or more people picked. */}
                {selectedPersonIds.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setPeopleMatchAny((v) => !v)}
                    className="px-2.5 py-1 rounded-full border text-xs"
                    style={{
                      color: 'var(--color-text)',
                      borderColor: 'var(--color-surface-border)',
                    }}
                  >
                    {peopleMatchAny
                      ? t('gallery.people.matchAny', { defaultValue: 'Either person' })
                      : t('gallery.people.matchAll', { defaultValue: 'Both people' })}
                  </button>
                )}

                {/* ml-auto only once there's room for it — at 390px the count
                    and Clear were pushed against the right edge and clipped. */}
                <span className="text-sm sm:ml-auto" style={{ color: 'var(--color-muted-text)' }}>
                  {t('gallery.people.matchCount', {
                    count: filteredPhotos.length,
                    // Scoped denominator (#1160): at a folder root this said
                    // "42 of 62" while only 42 exist in the view.
                    total: scopedPhotos.length,
                    defaultValue: `${filteredPhotos.length} of ${scopedPhotos.length} photos`,
                  })}
                </span>

                {/* Hidden entirely when downloads are off for the gallery,
                    rather than shown-and-failing. */}
                {allowDownloads && peopleDownloadableIds.length > 0 && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleDownloadPeopleFiltered}
                    leftIcon={<Download className="w-4 h-4" />}
                  >
                    {t('gallery.people.downloadThese', {
                      count: peopleDownloadableIds.length,
                      defaultValue: `Download these ${peopleDownloadableIds.length}`,
                    })}
                  </Button>
                )}

                <button
                  type="button"
                  onClick={() => { setSelectedPersonIds([]); setPeopleMatchAny(false); }}
                  className="text-sm underline"
                  style={{ color: 'var(--color-muted-text)' }}
                >
                  {t('gallery.people.clear', { defaultValue: 'Clear' })}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Photo Grid — when the hero header sits directly under the filter
            bar, double the wrapper margin (mt-12) so the hero's decorative
            `-mt-6` bleed leaves a visible gap instead of gluing the filter
            bar to the hero image (issue #624). */}
        <div className={toolbarShown && isHeroHeader ? "mt-12" : "mt-6"}>
          {/* Download limit (issue 1560): the guest's counter. */}
          {allowDownloads && (downloadQuota.limited || downloadQuota.previewOnly) && (
            <div className="mb-4">
              <DownloadQuotaNotice />
            </div>
          )}
          {folderNav}
          {/* A gallery whose photos ALL live in folders has an empty root grid,
              and PhotoGridWithLayouts unconditionally renders "no photos found"
              — directly under the tiles that prove otherwise. Skip the grid when
              the tiles are the entire content. */}
          <PhotoGridWithLayouts
            key={gridKey}
            photos={filteredPhotos}
            afterGrid={showDeliveryBanner
              ? <GalleryDeliveryBanner delivery={delivery} className="mt-8" />
              : undefined}
            openPhotoId={linkedPhotoId}
            onLightboxPhotoChange={handleLightboxPhotoChange}
            suppressEmptyState={rootIsFoldersOnly}
            emptyIsFiltered={emptyIsFiltered}
            slug={slug}
            people={peopleEnabled ? people : undefined}
            onSelectPerson={togglePerson} 
            categoryId={selectedCategoryId}
            onFeedbackChange={handleFeedbackChange}
            heroPhotoOverride={staticHeroPhoto}
            feedbackEnabled={feedbackEnabled}
            feedbackOptions={{
              allowLikes: !!feedbackSettings?.allow_likes,
              allowFavorites: !!feedbackSettings?.allow_favorites,
              allowRatings: !!feedbackSettings?.allow_ratings,
              allowComments: !!feedbackSettings?.allow_comments,
              allowReactions: !!feedbackSettings?.allow_reactions,
              requireNameEmail: !!feedbackSettings?.require_name_email,
            }}
            isSelectionMode={isSelectionMode}
            selectedPhotos={selectedPhotos}
            onSelectionChange={setSelectedPhotos}
            photosForIds={photosForIds}
            onToggleSelectionMode={() => setIsSelectionMode(!isSelectionMode)}
            eventName={event.event_name}
            eventLogo={data?.event?.hero_logo_url || brandingSettings?.logo_url}
            eventDate={event.event_date}
            expiresAt={event.expires_at}
            allowDownloads={allowDownloads}
            downloadChoices={downloadChoices}
            downloadStandard={data?.event?.download_resolution?.standard}
            protectionLevel={protectionLevel}
            useEnhancedProtection={protectionLevel !== 'basic'}
            disableRightClick={disableRightClick}
            enableDevtoolsProtection={enableDevtoolsProtection}
            useCanvasRendering={useCanvasRendering}
            heroLogoVisible={data?.event?.hero_logo_visible !== false}
            heroLogoSize={data?.event?.hero_logo_size || 'medium'}
            heroLogoPosition={data?.event?.hero_logo_position || 'top'}
            headerStyle={data?.event?.header_style || theme.headerStyle}
            heroDividerStyle={data?.event?.hero_divider_style || theme.heroDividerStyle || 'wave'}
            heroImageAnchor={data?.event?.hero_image_anchor || 'center'}
            welcomeMessage={event.welcome_message}
            isClient={isClient}
            onToggleVisibility={isClient ? handleToggleVisibility : undefined}
            showOriginalFilename={showOriginalFilename}
            onCopyFilenames={() => setShowCopyFilenames(true)}
            copyFilenamesCount={copyFilenames.photos.length}
          />
        </div>

        {/* Filename list for a RAW editor search (issue 1733, A3d). */}
        {showCopyFilenames && (
          <CopyFilenamesDialog
            photos={copyFilenames.photos}
            source={copyFilenames.source}
            onClose={() => setShowCopyFilenames(false)}
          />
        )}

        {/* Upload Modal */}
        {showUploadModal && allowUploads && (
          <UserPhotoUpload
            eventId={data?.event?.id || event?.id}
            categoryId={data?.event?.upload_category_id || event?.upload_category_id}
            {...uploaderNameProps}
            onUploadComplete={handleUploadComplete}
            onClose={() => setShowUploadModal(false)}
          />
        )}
        {uploadProcessingNotice}
        {newPhotosPill}

        {/* Download size picker (#858) — "download all", or a selection. */}
        {(showResolutionPicker || resolutionPickerIds || resumeJobToken) && (
          <DownloadResolutionModal
            slug={slug}
            choices={downloadChoices}
            standardResolution={data?.event?.download_resolution?.standard}
            photoIds={resolutionPickerIds || undefined}
            quotaPhotos={resolutionPickerIds ? photosForIds(resolutionPickerIds) : allDownloadablePhotos}
            resumeToken={resumeJobToken || undefined}
            onDownloaded={handlePickerDownloaded}
            onClose={() => {
              setShowResolutionPicker(false);
              setResolutionPickerIds(null);
              setPickerForSelection(false);
              setResumeJobToken(null);
              clearDownloadJobParam();
            }}
          />
        )}

        {/* "Show all" people (#1074) — a bottom sheet on mobile. */}
        {peopleEnabled && (
          <PeopleSheet
            open={showPeopleSheet}
            onClose={() => setShowPeopleSheet(false)}
            people={people}
            photos={scopedPhotos}
            slug={slug}
            selectedPersonIds={selectedPersonIds}
            onToggle={togglePerson}
          />
        )}
      </GalleryLayout>
      </GridDensityOffered.Provider>
      </PhotoLabelsProvider>
      </GalleryTileBadgesProvider>
      </PhotoDownloadChoiceProvider>
    </DownloadQuotaProvider>
    </GuestIdentityProvider>
  );
};
