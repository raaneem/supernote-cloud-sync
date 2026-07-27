import { FuzzySuggestModal, TFolder, type App } from "obsidian";

interface FolderChoice {
  folder: TFolder;
  path: string;
}

interface VaultFolderPickerOptions {
  includeRoot?: boolean;
  placeholder?: string;
}

const normalizedFolderPath = (folder: TFolder): string =>
  folder.isRoot() ? "" : folder.path;

export class VaultFolderPickerModal extends FuzzySuggestModal<FolderChoice> {
  constructor(
    app: App,
    private readonly excludedFolder: string,
    private readonly choose: (path: string) => void,
    private readonly options: VaultFolderPickerOptions = {},
  ) {
    super(app);
    this.setPlaceholder(options.placeholder ?? "Choose an export folder");
  }

  getItems(): FolderChoice[] {
    const excluded = this.excludedFolder.replace(/^\/+|\/+$/g, "");
    const folders = [
      this.app.vault.getRoot(),
      ...this.app.vault
        .getAllLoadedFiles()
        .filter((item): item is TFolder => item instanceof TFolder)
        .filter((folder) => !folder.isRoot()),
    ];
    return folders
      .map((folder) => ({
        folder,
        path: normalizedFolderPath(folder),
      }))
      .filter(
        ({ path }) =>
          (this.options.includeRoot !== false || Boolean(path)) &&
          (!excluded ||
            (path !== excluded && !path.startsWith(`${excluded}/`))),
      )
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  getItemText(item: FolderChoice): string {
    return item.path || "Vault root";
  }

  onChooseItem(item: FolderChoice): void {
    this.choose(item.path);
  }
}
