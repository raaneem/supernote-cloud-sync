const replaceExtension = (
  path: string,
  sourceExtension: string,
  destinationExtension: string,
): string =>
  path.toLocaleLowerCase().endsWith(sourceExtension)
    ? `${path.slice(0, -sourceExtension.length)}${destinationExtension}`
    : path;

export const remotePathForLocal = (localRelativePath: string): string =>
  replaceExtension(localRelativePath, ".md", ".txt");

export const localPathForRemote = (remoteRelativePath: string): string =>
  replaceExtension(remoteRelativePath, ".txt", ".md");
