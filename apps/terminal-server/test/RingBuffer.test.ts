import { describe, expect, it } from "vitest";

import { RingBuffer } from "../src/session/RingBuffer.js";

describe("RingBuffer", () => {
  it("keeps only the newest bytes", () => {
    const buffer = new RingBuffer(5);

    buffer.append("hello");
    buffer.append(" world");

    expect(buffer.snapshotText()).toBe("world");
  });

  it("replaces content when a single chunk exceeds the limit", () => {
    const buffer = new RingBuffer(4);

    buffer.append("abcdefgh");

    expect(buffer.snapshotText()).toBe("efgh");
  });

  it("handles empty chunks, partial trims, clear, and size", () => {
    const buffer = new RingBuffer(5);

    buffer.append("");
    buffer.append("ab");
    buffer.append(Uint8Array.from([99, 100, 101, 102]));

    expect(buffer.snapshotText()).toBe("bcdef");
    expect(buffer.size).toBe(5);

    buffer.clear();
    expect(buffer.snapshot()).toEqual(Buffer.alloc(0));
    expect(buffer.size).toBe(0);
  });

  it("drops whole head chunks when overflow is larger than the first chunk", () => {
    const buffer = new RingBuffer(3);

    buffer.append("a");
    buffer.append("bc");
    buffer.append("de");

    expect(buffer.snapshotText()).toBe("cde");
  });
});
