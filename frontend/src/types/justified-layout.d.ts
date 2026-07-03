declare module 'justified-layout' {
  interface JustifiedLayoutOptions {
    containerWidth: number;
    containerPadding?: number | { top: number; right: number; bottom: number; left: number };
    boxSpacing?: number | { horizontal: number; vertical: number };
    targetRowHeight?: number;
    targetRowHeightTolerance?: number;
    maxNumRows?: number;
    forceAspectRatio?: boolean | number;
    showWidows?: boolean;
    fullWidthBreakoutRowCadence?: boolean | number;
    widowLayoutStyle?: 'left' | 'center' | 'justify';
  }

  interface Box {
    aspectRatio: number;
    top: number;
    left: number;
    width: number;
    height: number;
    forcedAspectRatio?: boolean;
  }

  interface JustifiedLayoutResult {
    containerHeight: number;
    widowCount: number;
    boxes: Box[];
  }

  type InputItem = number | { width: number; height: number };

  function justifiedLayout(
    input: InputItem[],
    options?: JustifiedLayoutOptions
  ): JustifiedLayoutResult;

  export = justifiedLayout;
}
