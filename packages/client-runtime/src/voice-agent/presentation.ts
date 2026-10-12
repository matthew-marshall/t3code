import type { VoiceAgentState } from "./session.ts";

/** One line on what the voice session is doing, for every client's voice control. */
export function voiceAgentStatus(state: VoiceAgentState): string {
  switch (state.phase) {
    case "idle":
      return "Voice off";
    case "connecting":
      return state.progress === "token"
        ? "Getting a session token…"
        : state.progress === "connecting"
          ? "Connecting to Gemini…"
          : state.progress === "setup"
            ? "Setting up the session…"
            : "Connecting…";
    case "error":
      return state.error ?? "Voice stopped.";
    case "live":
      if (state.progress === "microphone") return "Starting the microphone…";
      if (state.runningTools.length > 0) return "Working…";
      if (state.agentSpeaking) return "Speaking";
      if (state.talking || state.mode === "hands-free") return "Listening";
      return "Hold to talk";
  }
}
