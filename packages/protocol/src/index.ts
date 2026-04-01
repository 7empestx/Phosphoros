export const PROTOCOL_VERSION = 1;

export const CLIENT_MESSAGE_TYPES = [
  "auth",
  "input",
  "resize",
  "ping",
  "detach",
  "terminate",
] as const;

export const SERVER_MESSAGE_TYPES = [
  "ready",
  "output",
  "session_status",
  "snapshot",
  "pong",
  "exit",
  "error",
] as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

export interface AuthMessage {
  type: "auth";
  token: string;
  sessionId: string;
  cols: number;
  rows: number;
}

export interface InputMessage {
  type: "input";
  data: string;
}

export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export interface DetachMessage {
  type: "detach";
}

export interface TerminateMessage {
  type: "terminate";
}

export type ClientMessage =
  | AuthMessage
  | InputMessage
  | ResizeMessage
  | PingMessage
  | DetachMessage
  | TerminateMessage;

export interface ReadyMessage {
  type: "ready";
  sessionId: string;
  protocolVersion: number;
  reconnectable: boolean;
}

export interface OutputMessage {
  type: "output";
  data: string;
}

export interface SessionStatusMessage {
  type: "session_status";
  sessionId: string;
  connected: boolean;
  durable: boolean;
  cols: number;
  rows: number;
  idleExpiresAt: string | null;
}

export interface SnapshotMessage {
  type: "snapshot";
  data: string;
}

export interface PongMessage {
  type: "pong";
  ts: number;
}

export interface ExitMessage {
  type: "exit";
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ServerMessage =
  | ReadyMessage
  | OutputMessage
  | SessionStatusMessage
  | SnapshotMessage
  | PongMessage
  | ExitMessage
  | ErrorMessage;

export const BINARY_FRAME_KIND = {
  output: 1,
  snapshot: 2,
  input: 3,
} as const;

export type BinaryFrameKind = keyof typeof BINARY_FRAME_KIND;

export interface BinaryFrame {
  kind: BinaryFrameKind;
  data: Uint8Array;
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  return CLIENT_MESSAGE_TYPES.includes(value.type as ClientMessageType);
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  return SERVER_MESSAGE_TYPES.includes(value.type as ServerMessageType);
}

export function parseClientMessage(payload: string): ClientMessage {
  const value = JSON.parse(payload) as unknown;
  if (!isClientMessage(value)) {
    throw new Error("Invalid client message");
  }
  return value;
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const kind = BINARY_FRAME_KIND[frame.kind];
  const encoded = new Uint8Array(frame.data.length + 1);
  encoded[0] = kind;
  encoded.set(frame.data, 1);
  return encoded;
}

export function decodeBinaryFrame(payload: Uint8Array): BinaryFrame {
  const kind = Object.entries(BINARY_FRAME_KIND).find(([, value]) => value === payload[0])?.[0];
  if (!kind) {
    throw new Error("Invalid binary frame");
  }

  return {
    kind: kind as BinaryFrameKind,
    data: payload.subarray(1),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
