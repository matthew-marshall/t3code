import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A live voice session. The client connects to the model provider directly
 * with a short-lived token, so audio never passes through the environment;
 * the environment only issues the token and runs the session's tool calls.
 */
/** Gemini's prebuilt voices, with Google's one-word description of each. */
export const VOICE_AGENT_VOICES = [
  { name: "Zephyr", style: "Bright" },
  { name: "Puck", style: "Upbeat" },
  { name: "Charon", style: "Informative" },
  { name: "Kore", style: "Firm" },
  { name: "Fenrir", style: "Excitable" },
  { name: "Leda", style: "Youthful" },
  { name: "Orus", style: "Firm" },
  { name: "Aoede", style: "Breezy" },
  { name: "Callirrhoe", style: "Easy-going" },
  { name: "Autonoe", style: "Bright" },
  { name: "Enceladus", style: "Breathy" },
  { name: "Iapetus", style: "Clear" },
  { name: "Umbriel", style: "Easy-going" },
  { name: "Algieba", style: "Smooth" },
  { name: "Despina", style: "Smooth" },
  { name: "Erinome", style: "Clear" },
  { name: "Algenib", style: "Gravelly" },
  { name: "Rasalgethi", style: "Informative" },
  { name: "Laomedeia", style: "Upbeat" },
  { name: "Achernar", style: "Soft" },
  { name: "Alnilam", style: "Firm" },
  { name: "Schedar", style: "Even" },
  { name: "Gacrux", style: "Mature" },
  { name: "Pulcherrima", style: "Forward" },
  { name: "Achird", style: "Friendly" },
  { name: "Zubenelgenubi", style: "Casual" },
  { name: "Vindemiatrix", style: "Gentle" },
  { name: "Sadachbia", style: "Lively" },
  { name: "Sadaltager", style: "Knowledgeable" },
  { name: "Sulafat", style: "Warm" },
] as const;

/** Live has no speaking-rate parameter; pace is asked for in the instructions. */
export const VoiceAgentPace = Schema.Literals(["slow", "normal", "fast"]);
export type VoiceAgentPace = typeof VoiceAgentPace.Type;

export const VoiceAgentFunctionDeclaration = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  /** JSON Schema for the arguments, as the tool declares them over MCP. */
  parametersJsonSchema: Schema.Unknown,
});
export type VoiceAgentFunctionDeclaration = typeof VoiceAgentFunctionDeclaration.Type;

export const VoiceAgentSession = Schema.Struct({
  /** Single-use token that opens one Gemini Live connection. */
  token: TrimmedNonEmptyString,
  websocketUrl: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  systemInstruction: Schema.String,
  tools: Schema.Array(VoiceAgentFunctionDeclaration),
});
export type VoiceAgentSession = typeof VoiceAgentSession.Type;

export const VoiceAgentCallToolInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type VoiceAgentCallToolInput = typeof VoiceAgentCallToolInput.Type;

export const VoiceAgentCallToolResult = Schema.Struct({
  isError: Schema.Boolean,
  /** The tool's result as text, shortened for a spoken conversation. */
  output: Schema.String,
});
export type VoiceAgentCallToolResult = typeof VoiceAgentCallToolResult.Type;

export const VoiceAgentErrorCode = Schema.Literals(["not-configured", "token-request-failed"]);
export type VoiceAgentErrorCode = typeof VoiceAgentErrorCode.Type;

export class VoiceAgentError extends Schema.TaggedError<VoiceAgentError>()("VoiceAgentError", {
  code: VoiceAgentErrorCode,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "not-configured":
        return "Add a Gemini API key in Settings → General to use voice on this environment.";
      case "token-request-failed":
        return "Could not start a voice session with Gemini.";
    }
  }
}
