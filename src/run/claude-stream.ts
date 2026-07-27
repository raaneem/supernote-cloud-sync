import type { DesktopProcessObserver } from "../shared/desktop-command";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inputSummary = (input: unknown): string => {
  const serialized = JSON.stringify(input);
  const oneLine = (serialized ?? String(input)).replace(/\s+/g, " ");
  return oneLine.length > 500 ? `${oneLine.slice(0, 499)}…` : oneLine;
};

const renderParsedEvent = (raw: string): string[] => {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (!isObject(event)) {
    return [raw];
  }

  if (
    event.type === "system" &&
    event.subtype === "init" &&
    typeof event.model === "string"
  ) {
    return [`session started (${event.model})`];
  }

  if (event.type === "assistant" && isObject(event.message)) {
    const content = event.message.content;
    if (!Array.isArray(content)) {
      return [raw];
    }
    const rendered: string[] = [];
    for (const item of content) {
      if (!isObject(item)) {
        continue;
      }
      if (item.type === "text" && typeof item.text === "string") {
        rendered.push(item.text);
      } else if (item.type === "tool_use" && typeof item.name === "string") {
        const input = item.input === undefined ? {} : item.input;
        rendered.push(`→ ${item.name}(${inputSummary(input)})`);
      }
    }
    return rendered.length > 0 ? rendered : [raw];
  }

  if (event.type === "result") {
    const parts: string[] = [];
    if (typeof event.duration_ms === "number") {
      parts.push(`completed in ${(event.duration_ms / 1_000).toFixed(1)}s`);
    }
    if (typeof event.total_cost_usd === "number") {
      parts.push(`$${event.total_cost_usd.toFixed(4)}`);
    }
    return parts.length > 0 ? [parts.join(" · ")] : [raw];
  }

  return [raw];
};

const renderEvent = (raw: string): string[] => {
  try {
    return renderParsedEvent(raw);
  } catch {
    return [raw];
  }
};

export class ClaudeStreamRenderer {
  private pending = "";

  push(chunk: string): string[] {
    const lines = (this.pending + chunk).split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines.flatMap((line) => (line ? renderEvent(line) : []));
  }

  flush(): string[] {
    if (!this.pending) {
      return [];
    }
    const line = this.pending;
    this.pending = "";
    return renderEvent(line);
  }
}

export interface ClaudeProcessObserver {
  observer: DesktopProcessObserver;
  flush(): void;
}

export const renderClaudeProcess = (
  target: DesktopProcessObserver,
): ClaudeProcessObserver => {
  const renderer = new ClaudeStreamRenderer();
  const emit = (lines: readonly string[]): void => {
    for (const line of lines) {
      target.onStdout?.(`${line}\n`);
    }
  };
  return {
    observer: {
      onStdout: (chunk) => emit(renderer.push(chunk)),
      ...(target.onStderr ? { onStderr: target.onStderr } : {}),
      ...(target.setCancel ? { setCancel: target.setCancel } : {}),
    },
    flush: () => emit(renderer.flush()),
  };
};
