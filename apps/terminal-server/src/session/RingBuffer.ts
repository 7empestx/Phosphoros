export class RingBuffer {
  private readonly maxBytes: number;
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  append(data: Uint8Array): void {
    const chunk = Buffer.from(data);
    if (!chunk.length) {
      return;
    }

    if (chunk.length >= this.maxBytes) {
      this.chunks.length = 0;
      this.chunks.push(chunk.subarray(chunk.length - this.maxBytes));
      this.totalBytes = this.maxBytes;
      return;
    }

    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    this.trim();
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.totalBytes);
  }

  snapshotText(): string {
    return this.snapshot().toString("utf8");
  }

  clear(): void {
    this.chunks.length = 0;
    this.totalBytes = 0;
  }

  get size(): number {
    return this.totalBytes;
  }

  private trim(): void {
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.totalBytes - this.maxBytes;
      const head = this.chunks[0];
      if (overflow >= head.length) {
        this.chunks.shift();
        this.totalBytes -= head.length;
        continue;
      }

      this.chunks[0] = head.subarray(overflow);
      this.totalBytes -= overflow;
    }
  }
}
