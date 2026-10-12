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
  addListener(
    event: "onCapture",
    listener: (event: { data: string; level: number }) => void,
  ): EventSubscription;
  addListener(
    event: "onInputs",
    listener: (event: { inputs: ReadonlyArray<VoiceAudioInput> }) => void,
  ): EventSubscription;
  addListener(event: "onError", listener: (event: { message: string }) => void): EventSubscription;
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
): VoiceAgentAudio {
  const module = nativeModule;
  let subscriptions: Array<EventSubscription> = [];

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
  };
}
