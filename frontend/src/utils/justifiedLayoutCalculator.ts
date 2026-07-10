/**
 * Justified/row-based gallery layout algorithm (similar to Google Photos or Flickr)
 *
 * This algorithm arranges photos in rows where each row has the same height,
 * and photos are scaled to fit the container width exactly.
 */

export interface JustifiedPhoto {
  id: number;
  width: number;
  height: number;
  aspectRatio: number;
}

export interface JustifiedLayoutItem {
  photoId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rowIndex: number;
}

export interface JustifiedLayoutOptions {
  containerWidth: number;
  targetRowHeight: number;
  spacing: number;
  maxRowHeight?: number;  // Maximum row height (for last row)
  lastRowBehavior?: 'justify' | 'left' | 'center';  // How to handle the last row
}

export interface JustifiedLayoutResult {
  items: JustifiedLayoutItem[];
  containerHeight: number;
  rowCount: number;
}

/**
 * Get the aspect ratio for a photo, defaulting to 1:1 if dimensions are missing
 */
function getAspectRatio(photo: JustifiedPhoto): number {
  // If aspectRatio is provided and valid, use it
  if (photo.aspectRatio && photo.aspectRatio > 0 && isFinite(photo.aspectRatio)) {
    return photo.aspectRatio;
  }

  // Calculate from width/height if both are valid
  if (photo.width && photo.height && photo.width > 0 && photo.height > 0) {
    return photo.width / photo.height;
  }

  // Default to square (1:1) if no valid dimensions
  return 1;
}

/**
 * Calculate the width a photo would have at a given height
 */
function getPhotoWidthAtHeight(photo: JustifiedPhoto, height: number): number {
  return height * getAspectRatio(photo);
}

/**
 * Calculate the total width of photos in a row at a given height, including spacing
 */
function calculateRowWidth(
  photos: JustifiedPhoto[],
  height: number,
  spacing: number
): number {
  if (photos.length === 0) return 0;

  const photosWidth = photos.reduce(
    (sum, photo) => sum + getPhotoWidthAtHeight(photo, height),
    0
  );
  const spacingWidth = (photos.length - 1) * spacing;

  return photosWidth + spacingWidth;
}

/**
 * Calculate the exact height needed for a row to fit the container width
 */
function calculateRowHeight(
  photos: JustifiedPhoto[],
  containerWidth: number,
  spacing: number
): number {
  if (photos.length === 0) return 0;

  // Total spacing between photos
  const totalSpacing = (photos.length - 1) * spacing;

  // Available width for actual photo content
  const availableWidth = containerWidth - totalSpacing;

  // Sum of aspect ratios determines how width is distributed
  const totalAspectRatio = photos.reduce(
    (sum, photo) => sum + getAspectRatio(photo),
    0
  );

  // Height = available width / sum of aspect ratios
  // This ensures all photos at this height exactly fill the available width
  return availableWidth / totalAspectRatio;
}

/**
 * Position photos in a row with calculated dimensions
 */
function positionRowPhotos(
  photos: JustifiedPhoto[],
  rowHeight: number,
  startY: number,
  rowIndex: number,
  spacing: number,
  containerWidth: number,
  alignment: 'justify' | 'left' | 'center' = 'justify'
): JustifiedLayoutItem[] {
  if (photos.length === 0) return [];

  const items: JustifiedLayoutItem[] = [];

  // Calculate actual widths at this row height
  const photoWidths = photos.map(photo => getPhotoWidthAtHeight(photo, rowHeight));
  const totalPhotoWidth = photoWidths.reduce((sum, w) => sum + w, 0);
  const totalSpacing = (photos.length - 1) * spacing;
  const totalRowWidth = totalPhotoWidth + totalSpacing;

  // Calculate starting X position based on alignment
  let startX = 0;
  if (alignment === 'center') {
    startX = (containerWidth - totalRowWidth) / 2;
  } else if (alignment === 'left') {
    startX = 0;
  }
  // For 'justify', startX is 0 and we'll adjust spacing below

  let currentX = startX;

  // For justified alignment, we might need to adjust spacing to fill the row exactly
  let actualSpacing = spacing;
  if (alignment === 'justify' && photos.length > 1) {
    // Calculate the spacing needed to fill the container exactly
    const widthDifference = containerWidth - totalRowWidth;
    actualSpacing = spacing + widthDifference / (photos.length - 1);
  }

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const width = photoWidths[i];

    items.push({
      photoId: photo.id,
      x: currentX,
      y: startY,
      width: width,
      height: rowHeight,
      rowIndex: rowIndex,
    });

    currentX += width + (i < photos.length - 1 ? actualSpacing : 0);
  }

  return items;
}

/**
 * Main function to calculate the justified layout
 */
export function calculateJustifiedLayout(
  photos: JustifiedPhoto[],
  options: JustifiedLayoutOptions
): JustifiedLayoutResult {
  const {
    containerWidth,
    targetRowHeight,
    spacing,
    maxRowHeight = targetRowHeight * 1.5,
    lastRowBehavior = 'left',
  } = options;

  // Handle edge cases
  if (photos.length === 0) {
    return {
      items: [],
      containerHeight: 0,
      rowCount: 0,
    };
  }

  if (containerWidth <= 0) {
    return {
      items: [],
      containerHeight: 0,
      rowCount: 0,
    };
  }

  const items: JustifiedLayoutItem[] = [];
  const rows: JustifiedPhoto[][] = [];
  let currentRow: JustifiedPhoto[] = [];

  // Step 1: Assign photos to rows
  for (const photo of photos) {
    // Try adding this photo to the current row
    const testRow = [...currentRow, photo];
    const rowWidthAtTarget = calculateRowWidth(testRow, targetRowHeight, spacing);

    if (rowWidthAtTarget <= containerWidth) {
      // Photo fits in current row at target height
      currentRow.push(photo);
    } else if (currentRow.length === 0) {
      // Single photo that's wider than container - it gets its own row
      currentRow.push(photo);
      rows.push(currentRow);
      currentRow = [];
    } else {
      // Adding this photo would exceed container width
      // Finalize current row and start new one
      rows.push(currentRow);
      currentRow = [photo];
    }
  }

  // Don't forget the last row
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  // Step 2: Calculate positions for each row
  let currentY = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const isLastRow = rowIndex === rows.length - 1;

    // Calculate the height needed to justify this row
    let rowHeight = calculateRowHeight(row, containerWidth, spacing);

    // Determine alignment and height constraints for last row
    let alignment: 'justify' | 'left' | 'center' = 'justify';

    if (isLastRow) {
      // For the last row, we might not want to stretch photos too much
      if (lastRowBehavior === 'left' || lastRowBehavior === 'center') {
        // Use target height for last row (or max height if calculated is larger)
        if (rowHeight > maxRowHeight) {
          rowHeight = maxRowHeight;
        } else if (rowHeight > targetRowHeight * 1.2) {
          // If photos would be stretched too much, cap at a reasonable height
          rowHeight = targetRowHeight;
        }
        alignment = lastRowBehavior;
      } else {
        // Justify last row, but cap at max height
        if (rowHeight > maxRowHeight) {
          rowHeight = maxRowHeight;
          alignment = 'left'; // Fall back to left align if we can't justify within max height
        }
      }
    } else {
      // For non-last rows, always justify (fit exactly to container)
      // The calculated height should fit perfectly
    }

    // Position photos in this row
    const rowItems = positionRowPhotos(
      row,
      rowHeight,
      currentY,
      rowIndex,
      spacing,
      containerWidth,
      alignment
    );

    items.push(...rowItems);
    currentY += rowHeight + spacing;
  }

  // Remove the last spacing (no spacing after the last row)
  const containerHeight = currentY > 0 ? currentY - spacing : 0;

  return {
    items,
    containerHeight,
    rowCount: rows.length,
  };
}

/**
 * Helper function to create a JustifiedPhoto from raw photo data
 * Handles missing or invalid dimensions gracefully
 */
export function createJustifiedPhoto(
  id: number,
  width?: number | null,
  height?: number | null
): JustifiedPhoto {
  const w = width && width > 0 ? width : 0;
  const h = height && height > 0 ? height : 0;

  let aspectRatio: number;
  if (w > 0 && h > 0) {
    aspectRatio = w / h;
  } else {
    aspectRatio = 1; // Default to square
  }

  return {
    id,
    width: w || 1,
    height: h || 1,
    aspectRatio,
  };
}

/**
 * Batch convert photo data to JustifiedPhoto array
 */
export function createJustifiedPhotos(
  photos: Array<{ id: number; width?: number | null; height?: number | null }>
): JustifiedPhoto[] {
  return photos.map(photo => createJustifiedPhoto(photo.id, photo.width, photo.height));
}
