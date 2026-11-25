import { Heart } from 'lucide-react';

/** The "Collage" chip on a collage tile, bottom-left unless a layout puts it bottom-right. */
export function CollageChip({ corner = 'left' }: { corner?: 'left' | 'right' }) {
  return (
    <div className={corner === 'right' ? 'absolute bottom-2 right-2' : 'absolute bottom-2 left-2'}>
      <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">Collage</span>
    </div>
  );
}

/** The round "Liked" chip, bottom-left; above the Collage chip on a collage. */
export function LikedChip({ aboveCollage }: { aboveCollage: boolean }) {
  return (
    <div className={`absolute ${aboveCollage ? 'bottom-8' : 'bottom-2'} left-2 z-10`}>
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Liked">
        <Heart className="w-3.5 h-3.5 text-danger" fill="currentColor" />
      </span>
    </div>
  );
}
