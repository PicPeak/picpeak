import React, { useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { StaticPhotoAlbum, computeMasonryLayout } from 'react-photo-album';
import type { LayoutModel, Photo as AlbumPhoto, RenderPhotoContext } from 'react-photo-album';
import { ghostBox, gridBoxStyle, useMeasuredWindow, type TileBox } from './measuredWindow';

type AlbumWidth = [width: number | undefined, scrollbar: number | undefined];

// As MasonryPhotoAlbum does: a scrollbar that goes away does not widen the
// album, or the shorter tiles could bring it back, and so on.
function albumWidthReducer(state: AlbumWidth, next: AlbumWidth): AlbumWidth {
  const [width, scrollbar] = state;
  const [nextWidth, nextScrollbar] = next;
  if (width !== undefined && scrollbar !== undefined && nextWidth !== undefined && nextScrollbar !== undefined
    && nextWidth > width && nextWidth - width <= 20 && nextScrollbar < scrollbar) {
    return [width, nextScrollbar];
  }
  return width !== nextWidth || scrollbar !== nextScrollbar ? next : state;
}

interface PremiumWindowedAlbumProps<P extends AlbumPhoto> {
  photos: P[];
  renderTile: (context: RenderPhotoContext<P>, box: TileBox | undefined) => React.ReactNode;
  columns: (containerWidth: number) => number;
  spacing: number;
}

/**
 * Premium's MasonryPhotoAlbum for a large gallery (issue 2193): the same
 * layout from the same function, with only the tiles near the viewport mounted.
 */
export function PremiumWindowedAlbum<P extends AlbumPhoto & { key: string }>({
  photos,
  renderTile,
  columns,
  spacing,
}: PremiumWindowedAlbumProps<P>) {
  const albumRef = useRef<HTMLDivElement>(null);
  const [[width], dispatchWidth] = useReducer(albumWidthReducer, [undefined, undefined]);
  useLayoutEffect(() => {
    const album = albumRef.current;
    if (!album) return undefined;
    const update = () => dispatchWidth([album.clientWidth, window.innerWidth - document.documentElement.clientWidth]);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(album);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(
    () => (width === undefined ? undefined : computeMasonryLayout(photos, spacing, 0, width, columns(width))),
    [photos, spacing, width, columns],
  );
  const photoIds = useMemo(() => photos.map((photo) => Number(photo.key)), [photos]);
  // A like changes the photos, not the shapes in them.
  const shapes = useMemo(
    () => (model?.tracks ?? []).map((track) => track.photos.map((tile) => `${tile.photo.key}:${tile.height}`).join()).join('|'),
    [model],
  );

  const tileWindow = useMeasuredWindow(
    albumRef,
    photoIds,
    shapes,
    (root) => {
      const tiles = new Map<number, HTMLElement>();
      model?.tracks.forEach((track) => {
        const column = ghostBox(root, 'react-photo-album--track', {});
        track.photos.forEach((tile) => {
          tiles.set(Number(tile.photo.key), ghostBox(column, 'gallery-premium-photo-card', {
            width: '100%',
            height: `${tile.height}px`,
            display: 'block',
          }));
        });
      });
      return tiles;
    },
    model !== undefined,
    model === undefined,
  );

  const windowedModel = useMemo((): LayoutModel<P> | undefined => model && {
    ...model,
    tracks: model.tracks.map((track) => ({
      ...track,
      photos: track.photos.filter((tile) => tileWindow.mounted.has(Number(tile.photo.key))),
    })),
  }, [model, tileWindow.mounted]);

  return (
    <StaticPhotoAlbum
      layout="masonry"
      ref={albumRef}
      model={windowedModel}
      render={{
        // Keyed: a tile's place in its track changes as the window moves.
        photo: (_props, context) => (
          <React.Fragment key={context.photo.key}>
            {renderTile(context, tileWindow.boxes?.get(Number(context.photo.key)))}
          </React.Fragment>
        ),
      }}
      componentsProps={{ container: { style: gridBoxStyle(tileWindow) } }}
    />
  );
}
