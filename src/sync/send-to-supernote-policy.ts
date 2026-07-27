import { normalizeOptionalRelativePath } from "../shared/path";

export const resolveSendToSupernoteEnabled = (stored: {
  sendToSupernoteEnabled?: unknown;
  writableSubtreeConfigured?: unknown;
  settings?: unknown;
}): boolean =>
  typeof stored.sendToSupernoteEnabled === "boolean"
    ? stored.sendToSupernoteEnabled
    : typeof stored.writableSubtreeConfigured === "boolean"
      ? stored.writableSubtreeConfigured
      : typeof stored.settings === "object" &&
        stored.settings !== null &&
        "pushFolder" in stored.settings &&
        typeof stored.settings.pushFolder === "string" &&
        Boolean(stored.settings.pushFolder.trim());

export const isInsideSendToSupernoteFolder = (
  remotePath: string,
  folder: string,
): boolean => {
  const normalizedPath = normalizeOptionalRelativePath(remotePath);
  const normalizedFolder = normalizeOptionalRelativePath(folder);
  return Boolean(
    normalizedFolder &&
      (normalizedPath === normalizedFolder ||
        normalizedPath.startsWith(`${normalizedFolder}/`)),
  );
};
