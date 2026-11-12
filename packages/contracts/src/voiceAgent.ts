import * as Schema from "effect/Schema";

/** The realtime voice API the voice agent talks to. Each device keeps its own key for each. */
export const VoiceAgentProviderId = Schema.Literals(["gemini", "openai"]);
export type VoiceAgentProviderId = typeof VoiceAgentProviderId.Type;

/** OpenAI Realtime's built-in voices; OpenAI recommends Marin and Cedar. */
export const VOICE_AGENT_OPENAI_VOICES = [
  { name: "marin", style: "Natural" },
  { name: "cedar", style: "Natural" },
  { name: "alloy", style: "Neutral" },
  { name: "ash", style: "Clear" },
  { name: "ballad", style: "Expressive" },
  { name: "coral", style: "Warm" },
  { name: "echo", style: "Resonant" },
  { name: "sage", style: "Calm" },
  { name: "shimmer", style: "Bright" },
  { name: "verse", style: "Versatile" },
] as const;

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

/** Gemini Live has no speaking-rate parameter, so it is asked for in the instructions; OpenAI sets a speed. */
export const VoiceAgentPace = Schema.Literals(["slow", "normal", "fast"]);
export type VoiceAgentPace = typeof VoiceAgentPace.Type;
