import { describe, expect, it } from "vitest";

import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  PROTOCOL_VERSION,
  isClientMessage,
  isServerMessage,
  parseClientMessage,
  serializeServerMessage,
} from "../src/index.js";

describe("protocol", () => {
  it("parses valid client messages", () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: "auth",
        token: "signed-token",
        sessionId: "session-1",
        cols: 120,
        rows: 40,
      }),
    );

    expect(message.type).toBe("auth");
  });

  it("rejects invalid client messages", () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: "launch_missiles" })),
    ).toThrow("Invalid client message");
  });

  it("serializes server messages", () => {
    expect(
      serializeServerMessage({
        type: "ready",
        sessionId: "session-1",
        protocolVersion: PROTOCOL_VERSION,
        reconnectable: true,
      }),
    ).toContain("\"type\":\"ready\"");
  });

  it("type guards known client message types", () => {
    expect(
      isClientMessage({
        type: "resize",
        cols: 80,
        rows: 24,
      }),
    ).toBe(true);
  });

  it("rejects unknown and malformed shapes in type guards", () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage({})).toBe(false);
    expect(isServerMessage(null)).toBe(false);
    expect(isServerMessage({ type: "error", code: "x", message: "bad" })).toBe(true);
    expect(isServerMessage({ type: "mystery" })).toBe(false);
  });

  it("surfaces invalid json payloads", () => {
    expect(() => parseClientMessage("{")).toThrow();
  });

  it("encodes and decodes binary frames", () => {
    const encoded = encodeBinaryFrame({
      kind: "snapshot",
      data: new Uint8Array([65, 66]),
    });
    const decoded = decodeBinaryFrame(encoded);

    expect(decoded.kind).toBe("snapshot");
    expect(Array.from(decoded.data)).toEqual([65, 66]);
  });

  it("rejects unknown binary frames", () => {
    expect(() => decodeBinaryFrame(new Uint8Array([99, 65]))).toThrow(
      "Invalid binary frame",
    );
  });
});
