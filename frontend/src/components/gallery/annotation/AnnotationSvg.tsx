import React, { forwardRef, useMemo } from 'react';
import {
  ANNOTATION_PALETTE,
  parseAnnotation,
  strokePath,
  type AnnotationStroke,
} from '../../../utils/photoAnnotation';

interface AnnotationSvgProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'viewBox' | 'children'> {
  /** As the API returned it; validated here, so no caller can skip that. */
  annotation: unknown;
  /** Width / height of the box the SVG covers; keeps arrow heads undistorted. */
  aspect: number;
  /** The stroke under the pointer while drawing. Built locally from numbers. */
  pending?: AnnotationStroke | null;
  /** Line width in CSS pixels, whatever size the SVG is stretched to. */
  lineWidth?: number;
}

/**
 * A drawn annotation as SVG (issue 1733). The viewBox is the normalised
 * 0..1 image box, stretched over whatever rectangle the caller gives the
 * element, with non-scaling strokes so a line is as thick on a phone as on
 * a wide screen. One <path> per stroke, built only from validated numbers
 * and the fixed palette.
 */
export const AnnotationSvg = forwardRef<SVGSVGElement, AnnotationSvgProps>(
  ({ annotation, aspect, pending, lineWidth = 3, style, ...rest }, ref) => {
    const parsed = useMemo(() => parseAnnotation(annotation), [annotation]);
    const strokes = pending ? [...(parsed?.strokes ?? []), pending] : parsed?.strokes ?? [];
    return (
      <svg
        ref={ref}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        // The dark halo keeps a light line readable on a light photo and
        // the other way round.
        style={{ overflow: 'visible', filter: 'drop-shadow(0 0 1px rgba(0, 0, 0, 0.9))', ...style }}
        {...rest}
      >
        {strokes.map((stroke, index) => (
          <path
            key={index}
            d={strokePath(stroke, aspect)}
            fill="none"
            stroke={ANNOTATION_PALETTE[stroke.c]}
            strokeWidth={lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    );
  }
);

AnnotationSvg.displayName = 'AnnotationSvg';
