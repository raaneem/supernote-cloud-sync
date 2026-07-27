export interface RecognitionSpan {
  text: string;
  rect: readonly [number, number, number, number];
}

interface RecognitionElement {
  type: string;
  label: string;
  words?: readonly {
    label: string;
    "bounding-box"?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }[];
}

const decodeRecognitionLabel = (label: string): string => {
  try {
    return decodeURIComponent(escape(label));
  } catch {
    return label;
  }
};

export const recognitionSpansForElements = (
  elements: readonly RecognitionElement[],
): RecognitionSpan[] => {
  const textElements = elements.filter(
    (element) =>
      element.type === "Text" &&
      decodeRecognitionLabel(element.label).trim().length > 0,
  );
  if (
    textElements.length === 0 ||
    textElements.some(
      (element) =>
        !element.words?.length ||
        element.words.some((word) => {
          const box = word["bounding-box"];
          return (
            !decodeRecognitionLabel(word.label).trim() ||
            !box ||
            box.width <= 0 ||
            box.height <= 0
          );
        }),
    )
  ) {
    return [];
  }
  return textElements.flatMap((element) =>
    element.words!.map((word) => {
      const box = word["bounding-box"]!;
      return {
        text: decodeRecognitionLabel(word.label).trim(),
        rect: [box.x, box.y, box.width, box.height] as const,
      };
    }),
  );
};
