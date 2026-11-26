/** The gallery default photo sort choices, in display order. */
export const DEFAULT_PHOTO_SORT_OPTIONS = [
  { value: 'upload_date_desc', labelKey: 'photoSort.uploadDateNewest', fallback: 'Upload Date (Newest First)' },
  { value: 'upload_date_asc', labelKey: 'photoSort.uploadDateOldest', fallback: 'Upload Date (Oldest First)' },
  { value: 'capture_date_desc', labelKey: 'photoSort.captureDateNewest', fallback: 'Date Taken (Newest First)' },
  { value: 'capture_date_asc', labelKey: 'photoSort.captureDateOldest', fallback: 'Date Taken (Oldest First)' },
  { value: 'filename_asc', labelKey: 'photoSort.filenameAZ', fallback: 'Filename (A-Z)' },
  { value: 'filename_desc', labelKey: 'photoSort.filenameZA', fallback: 'Filename (Z-A)' },
] as const;
