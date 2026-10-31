export function isGalleryTemporarilyDisabled(error: unknown): boolean {
  return (error as { response?: { data?: { code?: string } } } | null)
    ?.response?.data?.code === 'GALLERY_TEMPORARILY_DISABLED';
}
