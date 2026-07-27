const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8Tail = (value: string, maxBytes: number): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let start = bytes.byteLength - maxBytes;
  while (
    start < bytes.byteLength &&
    (bytes[start]! & 0b1100_0000) === 0b1000_0000
  ) {
    start += 1;
  }
  return decoder.decode(bytes.subarray(start));
};

interface TextChunk {
  bytes: number;
  text: string;
}

/**
 * Retains a UTF-8 byte-bounded tail without copying prior output on append.
 * Joining is deliberately explicit and reserved for final result consumers.
 */
export class BoundedTextBuffer {
  private readonly chunks: TextChunk[] = [];
  private head = 0;
  private retainedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get byteLength(): number {
    return this.retainedBytes;
  }

  append(value: string): boolean {
    if (!value) {
      return false;
    }
    const inputBytes = encoder.encode(value).byteLength;
    const bounded = utf8Tail(value, this.maxBytes);
    if (!bounded) {
      return inputBytes > 0;
    }
    const bytes = encoder.encode(bounded).byteLength;
    let truncated = inputBytes > this.maxBytes;
    while (
      this.head < this.chunks.length &&
      this.retainedBytes + bytes > this.maxBytes
    ) {
      const oldest = this.chunks[this.head]!;
      const excess = this.retainedBytes + bytes - this.maxBytes;
      if (oldest.bytes > excess) {
        const previousBytes = oldest.bytes;
        oldest.text = utf8Tail(oldest.text, oldest.bytes - excess);
        oldest.bytes = encoder.encode(oldest.text).byteLength;
        this.retainedBytes -= previousBytes - oldest.bytes;
        truncated = true;
        break;
      }
      this.retainedBytes -= oldest.bytes;
      this.head += 1;
      truncated = true;
    }
    this.chunks.push({ bytes, text: bounded });
    this.retainedBytes += bytes;
    this.compact();
    return truncated;
  }

  text(): string {
    return this.chunks
      .slice(this.head)
      .map((chunk) => chunk.text)
      .join("");
  }

  clear(): void {
    this.chunks.length = 0;
    this.head = 0;
    this.retainedBytes = 0;
  }

  private compact(): void {
    if (this.head < 256 || this.head * 2 < this.chunks.length) {
      return;
    }
    this.chunks.splice(0, this.head);
    this.head = 0;
  }
}
