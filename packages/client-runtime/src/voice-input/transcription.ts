/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
};

/** Binds a recording to its selected implementation and resolved locale. */
export type PreparedVoiceTranscription = {
  readonly locale: string;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
};

export type VoiceTranscriber = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
};

export type VoiceTranscriptionErrorCode =
  | "unavailable"
  | "unsupported-locale"
  | "preparation-failed"
  | "transcription-failed"
  | "cancelled";

export class VoiceTranscriptionError extends Error {
  readonly code: VoiceTranscriptionErrorCode;
  /** Shown to the user instead of the generic message, when the transcriber knows what to do about it. */
  readonly displayMessage: string | null;

  constructor(
    code: VoiceTranscriptionErrorCode,
    message: string,
    options?: ErrorOptions & { readonly displayMessage?: string },
  ) {
    super(message, options);
    this.name = "VoiceTranscriptionError";
    this.code = code;
    this.displayMessage = options?.displayMessage ?? null;
  }
}

export function throwIfVoiceTranscriptionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
  }
}
