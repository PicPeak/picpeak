/**
 * A photo's focal point (issue 2377) as CSS object-position, or undefined for
 * none (the browser's centre).
 *
 * The one stored value fits every rendition. The server cuts a cover-cropped
 * thumbnail with object-position semantics (backend utils/focalPoint.js), so
 * the point sits at the same fraction of that thumbnail as of the whole
 * photo: a square thumbnail in a square tile has no slack and is left alone,
 * and a tile of any other shape crops around the same point again rather
 * than shifting it. Not for hero_url, which is cut around the event's own
 * anchor.
 */
export function focalObjectPosition(
  photo: { focal_point?: { x: number; y: number } | null } | null | undefined,
): string | undefined {
  const point = photo?.focal_point;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const percent = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10}%`;
  return `${percent(point.x)} ${percent(point.y)}`;
}

/** The image style for an object-cover tile of `photo`, merged over `style`. */
export function withFocalPosition(
  photo: Parameters<typeof focalObjectPosition>[0],
  style?: React.CSSProperties,
): React.CSSProperties | undefined {
  const objectPosition = focalObjectPosition(photo);
  return objectPosition ? { ...style, objectPosition } : style;
}
