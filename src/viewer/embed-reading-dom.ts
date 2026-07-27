import type { EmbedPresentation } from "./embed-syntax";

export const embeddedPageActivationKey = (key: string): boolean =>
  key === "Enter" || key === " ";

export class EmbeddedPageActivation {
  private suppressClicksUntil = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = () => performance.now()) {}

  completedGesture(action: "previous" | "next" | "snap-back"): void {
    this.suppressClicksUntil =
      action === "snap-back" ? Number.NEGATIVE_INFINITY : this.now() + 500;
  }

  shouldActivateClick(): boolean {
    return this.now() > this.suppressClicksUntil;
  }
}

export const renderedEmbedElements = (root: HTMLElement): HTMLElement[] => [
  ...(root.matches(".internal-embed") ? [root] : []),
  ...root.querySelectorAll<HTMLElement>(".internal-embed"),
];

export const renderedEmbedTarget = (element: HTMLElement): string | null =>
  element.getAttribute("src") ??
  element.getAttribute("data-src") ??
  element.getAttribute("data-href");

export const linkBasename = (linkpath: string): string =>
  linkpath.split("/").at(-1)?.toLocaleLowerCase() ?? linkpath;

export const applyEmbedPresentation = (
  container: HTMLElement,
  presentation: EmbedPresentation,
): void => {
  if (presentation.width !== null) {
    container.style.setProperty(
      "--supernote-embed-width",
      `${presentation.width}px`,
    );
    container.classList.add("has-explicit-width");
  }
  if (presentation.height !== null) {
    container.style.setProperty(
      "--supernote-embed-height",
      `${presentation.height}px`,
    );
    container.classList.add("has-explicit-height");
  }
};
