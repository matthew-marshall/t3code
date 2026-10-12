import type { VoiceAgentPace, VoiceAgentProviderId } from "@t3tools/contracts";

import type { VoiceAgentFunctionDeclaration, VoiceAgentMode } from "./liveProtocol.ts";

/** What the provider's server said, in the session's terms. */
export type VoiceProviderEvent =
  /** The session is set up; the microphone can start. */
  | { readonly type: "ready" }
  | { readonly type: "audio"; readonly data: string }
  /** The user started talking over the agent: queued speech is dropped. */
  | { readonly type: "interrupted" }
  | { readonly type: "heard"; readonly text: string }
  | { readonly type: "said"; readonly text: string }
  /** The agent finished its turn, including after a tool call it now waits on. */
  | { readonly type: "turn-complete" }
  | { readonly type: "tool-calls"; readonly calls: ReadonlyArray<VoiceToolCall> }
  | { readonly type: "tool-cancelled"; readonly ids: ReadonlyArray<string> }
  /** A handle a later connection can resume this conversation with. */
  | { readonly type: "resumable"; readonly handle: string }
  /** The server will close this connection soon; move to a new one now. */
  | { readonly type: "go-away" }
  /** A request the server rejected; the session goes on. */
  | { readonly type: "error"; readonly message: string };

export interface VoiceToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export type VoiceToolResult = {
  readonly id: string;
  readonly name: string;
} & ({ readonly output: string } | { readonly error: string });

/** How a connection is set up when it opens. */
export interface VoiceSessionSetup {
  readonly instructions: string;
  readonly tools: ReadonlyArray<VoiceAgentFunctionDeclaration>;
  readonly mode: VoiceAgentMode;
  /** A voice the provider offers, or null for its default. */
  readonly voice: string | null;
  readonly pace: VoiceAgentPace;
  /** BCP 47, such as "en-US". */
  readonly language: string;
  /** Continues an earlier connection's conversation, when the provider offers that. */
  readonly resumptionHandle: string | null;
}

/**
 * One connection's protocol. It sends through the `send` it was created with, and keeps whatever
 * per-connection state the provider's rules need.
 */
export interface VoiceProviderConnection {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  /** Called once the socket opens. */
  setup(setup: VoiceSessionSetup): void;
  receive(data: unknown): ReadonlyArray<VoiceProviderEvent>;
  sendAudio(base64Pcm: string): void;
  /** Hands-free stopped sending the microphone after quiet; the next `sendAudio` resumes. */
  pauseAudio(): void;
  /** An app update the agent should hear about. */
  sendText(text: string): void;
  sendToolResults(results: ReadonlyArray<VoiceToolResult>): void;
  /** Push-to-talk pressed: interrupt any speech and open a user turn. */
  beginTalking(): void;
  /** Push-to-talk released: the agent answers what was said. */
  endTalking(): void;
}

/**
 * A realtime voice API the session can talk to. The device holds the key and exchanges it for a
 * short-lived credential per connection, so no T3 server is involved.
 */
export interface VoiceAgentProvider {
  readonly id: VoiceAgentProviderId;
  readonly model: string;
  /** The microphone rate the provider takes, in Hz. Speech comes back at 24 kHz from both. */
  readonly inputSampleRate: number;
  /** Instructions only this provider needs, such as for tools it brings itself. */
  readonly instructions: string | null;
  connect(send: (message: object) => void): Promise<VoiceProviderConnection>;
}

const textDecoder = new TextDecoder();

/** Both APIs send JSON, as text or binary frames depending on the platform's WebSocket. */
export function decodeJsonFrame(data: unknown): Record<string, unknown> | null {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
        ? textDecoder.decode(data)
        : null;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
