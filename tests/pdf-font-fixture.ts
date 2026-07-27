import { readFileSync } from "node:fs";

export const pdfFontBytes = new Uint8Array(
  readFileSync(
    new URL(
      "../node_modules/@expo-google-fonts/noto-sans-symbols-2/400Regular/NotoSansSymbols2_400Regular.ttf",
      import.meta.url,
    ),
  ),
);

export const pdfRegularFontBytes = new Uint8Array(
  readFileSync(
    new URL(
      "../node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf",
      import.meta.url,
    ),
  ),
);

export const pdfBoldFontBytes = new Uint8Array(
  readFileSync(
    new URL(
      "../node_modules/@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf",
      import.meta.url,
    ),
  ),
);
