import { Component, type App, type TFile } from "obsidian";

import type { NotebookSessionProvider } from "../note/notebook-service";
import {
  parseFixedPageEmbed,
  parseInvalidFixedPageEmbed,
} from "./fixed-page-embed";
import {
  FixedPageReadingView,
  InvalidFixedPageReadingView,
} from "./fixed-page-reading-view";
import { parseNotebookEmbed } from "./notebook-embed";
import { NotebookReadingView } from "./notebook-reading-view";

interface NativeEmbedContext {
  readonly app: App;
  readonly containerEl: HTMLElement;
  readonly linktext: string;
  readonly sourcePath: string;
}

type NativeEmbedCreator = (
  context: NativeEmbedContext,
  file: TFile,
  subpath: string,
) => Component & { loadFile(): Promise<void> };

interface NativeEmbedRegistry {
  isExtensionRegistered(extension: string): boolean;
  registerExtension(extension: string, creator: NativeEmbedCreator): void;
  unregisterExtension(extension: string): void;
}

interface AppWithEmbedRegistry extends App {
  readonly embedRegistry?: NativeEmbedRegistry;
}

interface EmbedRegistrationOwner {
  readonly app: App;
  register(callback: () => void): void;
}

interface NativeEmbedRendererOptions {
  readonly notebooks: () => NotebookSessionProvider;
}

interface EmbedAttributes {
  getAttribute(name: string): string | null;
}

const positiveDimension = (value: string | null): number | null => {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const dimension = Number.parseInt(value, 10);
  return dimension > 0 ? dimension : null;
};

export const nativeEmbedMarkdown = (
  linktext: string,
  attributes: EmbedAttributes,
): string => {
  const width = positiveDimension(attributes.getAttribute("width"));
  const height = positiveDimension(attributes.getAttribute("height"));
  const alt = attributes.getAttribute("alt")?.trim() ?? "";
  const generatedPreviewLabel = linktext.replace(
    /#([^#]+)$/,
    (_match, subpath: string) => ` > ${subpath}`,
  );
  const caption = alt === linktext || alt === generatedPreviewLabel ? "" : alt;
  const alias = width
    ? `|${width}${height ? `x${height}` : ""}`
    : caption
      ? `|${caption}`
      : "";
  return `![[${linktext}${alias}]]`;
};

class SupernoteNativeEmbed extends Component {
  private mounted = false;

  constructor(
    private readonly context: NativeEmbedContext,
    private readonly file: TFile,
    private readonly options: NativeEmbedRendererOptions,
  ) {
    super();
  }

  async loadFile(): Promise<void> {
    if (this.mounted) {
      return;
    }

    // Obsidian applies parsed alias dimensions to the native embed container
    // immediately after asking the registry for its renderer.
    await Promise.resolve();
    if (this.mounted) {
      return;
    }
    this.mounted = true;

    const { app, containerEl, linktext, sourcePath } = this.context;
    const markdown = nativeEmbedMarkdown(linktext, containerEl);
    const frame = document.createElement("figure");
    frame.classList.add("supernote-live-preview-widget");
    containerEl.replaceChildren(frame);

    const open = (pageNumber: number | null): void => {
      void app.workspace.openLinkText(
        `${this.file.path}${pageNumber === null ? "" : `#page=${pageNumber}`}`,
        sourcePath,
      );
    };
    const fixed = parseFixedPageEmbed(markdown);
    if (fixed) {
      this.addChild(
        new FixedPageReadingView(frame, {
          app,
          file: this.file,
          spec: fixed,
          notebooks: this.options.notebooks(),
          openPage: () => open(fixed.pageNumber),
          openNotebook: () => open(fixed.pageNumber),
        }),
      );
      return;
    }
    const invalid = parseInvalidFixedPageEmbed(markdown);
    if (invalid) {
      this.addChild(
        new InvalidFixedPageReadingView(frame, {
          file: this.file,
          spec: invalid,
          openNotebook: () => open(null),
        }),
      );
      return;
    }
    const notebook = parseNotebookEmbed(markdown);
    if (notebook) {
      this.addChild(
        new NotebookReadingView(frame, {
          app,
          file: this.file,
          spec: notebook,
          notebooks: this.options.notebooks(),
          openReader: (pageNumber) => open(pageNumber),
        }),
      );
    }
  }
}

export const registerSupernoteNativeEmbed = (
  owner: EmbedRegistrationOwner,
  options: NativeEmbedRendererOptions,
): boolean => {
  // Live Preview's built-in embed widget owns syntax, cursor reveal, viewport
  // recycling, and Component teardown. Obsidian does not expose this registry
  // in its public typings, so keep the integration feature-detected.
  const registry = (owner.app as AppWithEmbedRegistry).embedRegistry;
  if (!registry || registry.isExtensionRegistered("note")) {
    return false;
  }
  registry.registerExtension(
    "note",
    (context, file) => new SupernoteNativeEmbed(context, file, options),
  );
  owner.register(() => registry.unregisterExtension("note"));
  return true;
};
