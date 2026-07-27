const pathSegments = (path: string): string[] =>
  path.replaceAll("\\", "/").split("/").filter(Boolean);

const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const vaultSafeName = (name: string): string => {
  let safe = [...name]
    .map((character) =>
      character.charCodeAt(0) <= 31 || '\\<>:"|?*'.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .replace(/[. ]+$/g, (trailing) => "_".repeat(trailing.length));
  if (!safe || safe === "." || safe === "..") {
    safe = "_".repeat(Math.max(1, safe.length));
  }
  if (safe.startsWith(".")) {
    safe = `_${safe}`;
  }
  if (RESERVED_DEVICE_NAME.test(safe)) {
    safe = `_${safe}`;
  }
  return safe;
};

export const normalizeRemotePath = (path: string): string => {
  const normalized = path.split("/").filter(Boolean).join("/");
  if (!normalized) {
    throw new Error(`Unsafe remote path: ${path}`);
  }
  return normalized;
};

const assertSafeSegments = (
  path: string,
  segments: readonly string[],
): void => {
  if (
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || segment.includes("\0"),
    )
  ) {
    throw new Error(`Unsafe vault path: ${path}`);
  }
};

export const normalizeOptionalRelativePath = (path: string): string => {
  const segments = pathSegments(path.trim());
  assertSafeSegments(path, segments);
  return segments.join("/");
};

export const normalizeRelativePath = (path: string): string => {
  const normalized = normalizeOptionalRelativePath(path);
  if (!normalized) {
    throw new Error(`Unsafe vault path: ${path}`);
  }
  return normalized;
};
