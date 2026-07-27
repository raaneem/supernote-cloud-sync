export interface DisplayCanvasSizeInput {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly devicePixelRatio: number;
}

export interface DisplayCanvasBackingSize {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface DisplayCanvasBox {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

const positiveDimension = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 1;

const displayPixelRatio = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.max(1, value) : 1;

export const displayCanvasBoxKey = ({
  width,
  height,
  devicePixelRatio,
}: DisplayCanvasBox): string => {
  const dpr = displayPixelRatio(devicePixelRatio);
  return `${Math.ceil(positiveDimension(width) * dpr)}:${Math.ceil(
    positiveDimension(height) * dpr,
  )}:${dpr}`;
};

export const displayCanvasBackingSize = ({
  sourceWidth,
  sourceHeight,
  displayWidth,
  displayHeight,
  devicePixelRatio,
}: DisplayCanvasSizeInput): DisplayCanvasBackingSize => {
  const nativeWidth = Math.max(1, Math.trunc(positiveDimension(sourceWidth)));
  const nativeHeight = Math.max(1, Math.trunc(positiveDimension(sourceHeight)));
  const cssWidth = positiveDimension(displayWidth);
  const cssHeight = positiveDimension(displayHeight);
  const dpr = displayPixelRatio(devicePixelRatio);
  const displayScale = Math.min(
    cssWidth / nativeWidth,
    cssHeight / nativeHeight,
  );
  const backingScale = Math.min(1, displayScale * dpr);
  const width = Math.min(
    nativeWidth,
    Math.max(1, Math.ceil(nativeWidth * backingScale)),
  );
  const height = Math.min(
    nativeHeight,
    Math.max(1, Math.ceil(nativeHeight * backingScale)),
  );
  return {
    width,
    height,
    bytes: width * height * 4,
  };
};
