import { BoundedTextBuffer, utf8Tail } from "../shared/bounded-text-buffer";

export interface RunLogEntry {
  sequence: number;
  text: string;
}

export interface RunLogDelta {
  cursor: number;
  entries: readonly RunLogEntry[];
  oldestSequence: number;
  truncated: boolean;
}

interface RetainedLogEntry extends RunLogEntry {
  bytes: number;
}

const encoder = new TextEncoder();

export class SequencedRunLog {
  private readonly entries: RetainedLogEntry[] = [];
  private head = 0;
  private retainedBytes = 0;
  private nextSequence = 1;

  constructor(private readonly maxBytes: number) {}

  get byteLength(): number {
    return this.retainedBytes;
  }

  get cursor(): number {
    return this.nextSequence - 1;
  }

  append(text: string): RunLogEntry {
    const bounded = utf8Tail(text, this.maxBytes);
    const entry: RetainedLogEntry = {
      bytes: encoder.encode(bounded).byteLength,
      sequence: this.nextSequence,
      text: bounded,
    };
    this.nextSequence += 1;
    while (
      this.head < this.entries.length &&
      this.retainedBytes + entry.bytes > this.maxBytes
    ) {
      this.retainedBytes -= this.entries[this.head]!.bytes;
      this.head += 1;
    }
    this.entries.push(entry);
    this.retainedBytes += entry.bytes;
    this.compact();
    return entry;
  }

  read(afterSequence = 0): RunLogDelta {
    const oldestSequence =
      this.entries[this.head]?.sequence ?? this.nextSequence;
    const firstIndex =
      this.head + Math.max(0, afterSequence - oldestSequence + 1);
    return {
      cursor: this.cursor,
      entries: this.entries
        .slice(Math.min(this.entries.length, firstIndex))
        .map(({ bytes: _bytes, ...entry }) => entry),
      oldestSequence,
      truncated: afterSequence > 0 && afterSequence < oldestSequence - 1,
    };
  }

  text(): string {
    return this.entries
      .slice(this.head)
      .map((entry) => entry.text)
      .join("");
  }

  private compact(): void {
    if (this.head < 256 || this.head * 2 < this.entries.length) {
      return;
    }
    this.entries.splice(0, this.head);
    this.head = 0;
  }
}

/**
 * Line-buffers streamed process chunks while bounding an unterminated line.
 */
export class RunStreamLineBuffer {
  private readonly pending: BoundedTextBuffer;
  private trailingCarriageReturn = false;

  constructor(maxBytes: number) {
    this.pending = new BoundedTextBuffer(maxBytes);
  }

  push(chunk: string): string[] {
    const lines: string[] = [];
    let value = chunk;
    if (this.trailingCarriageReturn) {
      if (value.startsWith("\n")) {
        lines.push(this.takePending());
        value = value.slice(1);
      } else {
        this.pending.append("\r");
      }
      this.trailingCarriageReturn = false;
    }
    if (value.endsWith("\r")) {
      this.trailingCarriageReturn = true;
      value = value.slice(0, -1);
    }
    const segments = value.split("\n");
    for (const segment of segments.slice(0, -1)) {
      this.pending.append(
        segment.endsWith("\r") ? segment.slice(0, -1) : segment,
      );
      lines.push(this.takePending());
    }
    const overflowed = this.pending.append(segments.at(-1) ?? "");
    if (overflowed) {
      lines.push(this.takePending());
    }
    return lines;
  }

  flush(): string | null {
    if (this.trailingCarriageReturn) {
      this.pending.append("\r");
      this.trailingCarriageReturn = false;
    }
    if (this.pending.byteLength === 0) {
      return null;
    }
    return this.takePending();
  }

  private takePending(): string {
    const line = this.pending.text();
    this.pending.clear();
    return line;
  }
}
