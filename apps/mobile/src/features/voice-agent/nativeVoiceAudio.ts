import type { VoiceAgentAudio } from "@t3tools/client-runtime/voice-agent";
import { type EventSubscription, requireOptionalNativeModule } from "expo";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { Platform } from "react-native";

interface VoiceAudioInput {
  readonly uid: string;
  readonly name: string;
  readonly type: string;
}

interface T3VoiceAudioModule {
  prepare(): Promise<ReadonlyArray<VoiceAudioInput>>;
  setInput(uid: string): Promise<void>;
  /** `sampleRate` is the capture rate the session's provider takes. */
  start(sampleRate: number): Promise<void>;
  stop(): Promise<void>;
  play(base64Pcm: string): void;
  clearPlayback(): void;
  playChime(kind: "start" | "end"): void;
  /** While on, play/pause presses send `onRemoteCommand`. */
  setRemoteControl(enabled: boolean): void;
  /** Resolves once on-device recognition is ready, which can include downloading its model. */
  startSpeechListener(locale: string): Promise<void>;
  /** The whole transcript since `startSpeechListener`. */
  stopSpeechListener(): Promise<string>;
  startRecording(): Promise<void>;
  /** The AAC recording of the capture since `startRecording`, or null if nothing was captured. */
  stopRecording(): Promise<RecordedAudio | null>;
  addListener(
    event: "onCapture",
    listener: (event: { data: string; level: number }) => void,
  ): EventSubscription;
  addListener(
    event: "onInputs",
    listener: (event: { inputs: ReadonlyArray<VoiceAudioInput> }) => void,
  ): EventSubscription;
  addListener(event: "onError", listener: (event: { message: string }) => void): EventSubscription;
  /** The current segment's text as it changes, then once with `isFinal` when it settles. */
  addListener(
    event: "onSpeech",
    listener: (event: { text: string; isFinal: boolean }) => void,
  ): EventSubscription;
  /** A play/pause press, while remote control is on. */
  addListener(event: "onRemoteCommand", listener: () => void): EventSubscription;
}

interface RecordedAudio {
  readonly uri: string;
  readonly mimeType: string;
}

/** Dictation pieces the native module adds to voice audio, all fed by the same capture. */
export interface NativeDictationAudio {
  playChime(kind: "start" | "end"): void;
  /** Play/pause presses call `onPress` until called again with null. */
  setRemoteControl(onPress: (() => void) | null): void;
  /**
   * Recognizes the capture on device. `onText` gets the current segment's text as it changes
   * (volatile guesses included) and once more with `isFinal` when the segment settles.
   */
  startPhraseListener(
    locale: string,
    onText: (text: string, isFinal: boolean) => void,
  ): Promise<void>;
  /** Stops recognition and returns every segment joined. */
  stopPhraseListener(): Promise<string>;
  /** Records the capture to a compressed file until `stopRecordingFile`. */
  startRecordingFile(): Promise<void>;
  stopRecordingFile(): Promise<RecordedAudio | null>;
}

// modules/t3-voice-audio; iOS only for now.
const nativeModule =
  Platform.OS === "ios" ? requireOptionalNativeModule<T3VoiceAudioModule>("T3VoiceAudio") : null;

/** Whether this build can hold a voice conversation. */
export const isVoiceAgentAudioAvailable = nativeModule !== null;

/**
 * Echo-cancelled microphone and speaker for a voice session, on the native
 * module. `selectInput` applies the user's microphone priority when the
 * session starts and whenever a microphone connects or disconnects.
 */
export function createNativeVoiceAudio(
  selectInput: (inputs: ReadonlyArray<VoiceAudioInput>) => VoiceAudioInput | null,
): VoiceAgentAudio & NativeDictationAudio {
  const module = nativeModule;
  let subscriptions: Array<EventSubscription> = [];
  let speechSubscription: EventSubscription | null = null;
  let remoteSubscription: EventSubscription | null = null;

  const applyInput = async (inputs: ReadonlyArray<VoiceAudioInput>) => {
    const input = selectInput(inputs);
    if (input !== null) await module?.setInput(input.uid);
  };

  const release = () => {
    for (const subscription of subscriptions) subscription.remove();
    subscriptions = [];
  };

  return {
    async startCapture(onChunk, onError, sampleRate) {
      if (module === null) {
        throw new Error("Voice needs a newer build of the app.");
      }
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Allow microphone access in Settings to talk to T3 Code.");
      }
      release();
      subscriptions = [
        module.addListener("onCapture", (event) => onChunk(event.data, event.level)),
        module.addListener("onError", (event) => onError(event.message)),
        module.addListener("onInputs", (event) => {
          applyInput(event.inputs).catch(() => {});
        }),
      ];
      await applyInput(await module.prepare());
      await module.start(sampleRate);
    },

    async stopCapture() {
      release();
      await module?.stop();
    },

    play(base64Pcm) {
      module?.play(base64Pcm);
    },

    clearPlayback() {
      module?.clearPlayback();
    },

    playChime(kind) {
      module?.playChime(kind);
    },

    setRemoteControl(onPress) {
      remoteSubscription?.remove();
      remoteSubscription =
        onPress === null || module === null
          ? null
          : module.addListener("onRemoteCommand", () => onPress());
      module?.setRemoteControl(onPress !== null);
    },

    async startPhraseListener(locale, onText) {
      if (module === null) {
        throw new Error("Dictation needs a newer build of the app.");
      }
      speechSubscription?.remove();
      speechSubscription = module.addListener("onSpeech", (event) =>
        onText(event.text, event.isFinal),
      );
      try {
        await module.startSpeechListener(locale);
      } catch (error) {
        speechSubscription.remove();
        speechSubscription = null;
        throw error;
      }
    },

    async stopPhraseListener() {
      const transcript = (await module?.stopSpeechListener()) ?? "";
      speechSubscription?.remove();
      speechSubscription = null;
      return transcript;
    },

    async startRecordingFile() {
      if (module === null) {
        throw new Error("Dictation needs a newer build of the app.");
      }
      await module.startRecording();
    },

    async stopRecordingFile() {
      return (await module?.stopRecording()) ?? null;
    },
  };
}
