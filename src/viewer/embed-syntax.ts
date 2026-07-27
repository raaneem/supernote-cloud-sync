export interface WikiEmbed {
  readonly target: string;
  readonly alias: string | null;
}

export interface EmbedPresentation {
  readonly width: number | null;
  readonly height: number | null;
  readonly caption: string | null;
}

const splitAlias = (value: string): [string, string | null] => {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "|" && value[index - 1] !== "\\") {
      return [value.slice(0, index), value.slice(index + 1)];
    }
  }
  return [value, null];
};

export const positiveInteger = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const parseWikiEmbed = (markdown: string): WikiEmbed | null => {
  const match = /^!\[\[([\s\S]+)\]\]$/.exec(markdown.trim());
  const inner = match?.[1];
  if (!inner) {
    return null;
  }
  const [target, alias] = splitAlias(inner);
  return {
    target: target.trim(),
    alias: alias?.trim() ?? null,
  };
};

export const parseEmbedPresentation = (
  alias: string | null,
): EmbedPresentation => {
  const value = alias ?? "";
  const sizeMatch = /^(\d+)(?:x(\d+))?$/i.exec(value);
  const width =
    sizeMatch?.[1] !== undefined ? positiveInteger(sizeMatch[1]) : null;
  const height =
    sizeMatch?.[2] !== undefined ? positiveInteger(sizeMatch[2]) : null;
  return {
    width,
    height,
    caption: value && !sizeMatch ? value : null,
  };
};

export const markdownWikiEmbeds = (markdown: string): string[] =>
  [...markdown.matchAll(/!\[\[[^\]]+\]\]/g)].map((match) => match[0]);
