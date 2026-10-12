import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

/** Formats to try, in order, with the audio type Gemini knows each one by. */
const RECORDING_FORMATS = [
  // Chromium and Electron.
  { recorderType: "audio/webm;codecs=opus", geminiType: "audio/webm" },
  { recorderType: "audio/webm", geminiType: "audio/webm" },
  // Safari records AAC in an MP4 container.
  { recorderType: "audio/mp4", geminiType: "audio/m4a" },
  { recorderType: "audio/ogg;codecs=opus", geminiType: "audio/ogg" },
] as const;

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
};

function geminiTypeFor(recorderType: string): string {
  return (
    RECORDING_FORMATS.find((format) => recorderType.startsWith(format.recorderType.split(";")[0]!))
      ?.geminiType ?? "audio/webm"
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

/**
 * Browser microphone recording for dictation. A recording is a blob URL that
 * lives until the controller deletes it; `onStatus` reports the time limit
 * ending a recording, as expo-audio's recorder does on mobile.
 */
export function createWebVoiceRecorder(onStatus: (status: VoiceRecorderStatus) => void) {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Array<Blob> = [];
  let uri: string | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> | null = null;
  const recordings = new Map<string, Blob>();

  const releaseStream = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const finish = (): Promise<void> => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
    const active = recorder;
    if (active === null || active.state === "inactive") {
      releaseStream();
      return stopping ?? Promise.resolve();
    }
    stopping = new Promise((resolve) => {
      active.addEventListener(
        "stop",
        () => {
          const blob = new Blob(chunks, { type: active.mimeType });
          uri = URL.createObjectURL(blob);
          recordings.set(uri, blob);
          chunks = [];
          recorder = null;
          stopping = null;
          releaseStream();
          resolve();
        },
        { once: true },
      );
      active.stop();
    });
    return stopping;
  };

  const voiceRecorder: VoiceRecorder = {
    get uri() {
      return uri;
    },
    async prepareToRecordAsync() {
      uri = null;
      chunks = [];
      stream ??= await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      const format = RECORDING_FORMATS.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate.recorderType),
      );
      recorder = new MediaRecorder(stream, format ? { mimeType: format.recorderType } : undefined);
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
    },
    record({ forDuration }) {
      recorder?.start();
      limitTimer = setTimeout(() => {
        void finish().then(() =>
          onStatus({ isFinished: true, hasError: false, error: null, url: uri }),
        );
      }, forDuration * 1000);
    },
    stop: finish,
  };

  return {
    recorder: voiceRecorder,
    /**
     * Asks for the microphone. The stream is closed straight away: the controller only
     * releases the recording once it is set up, so a stream kept from here would leave
     * the microphone on when preparing the transcriber fails.
     */
    requestPermission: async () => {
      try {
        const granted = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        for (const track of granted.getTracks()) track.stop();
        return { granted: true, canAskAgain: true };
      } catch (error) {
        const denied = error instanceof DOMException && error.name === "NotAllowedError";
        return { granted: false, canAskAgain: !denied };
      }
    },
    /** Lets go of the microphone when dictation ends without recording. */
    release: async () => {
      await finish();
    },
    readRecording: async (recordingUri: string) => {
      const blob = recordings.get(recordingUri);
      if (blob === undefined) throw new Error("The recording is no longer available.");
      return { data: await blobToBase64(blob), mimeType: geminiTypeFor(blob.type) };
    },
    deleteRecording: (recordingUri: string) => {
      recordings.delete(recordingUri);
      URL.revokeObjectURL(recordingUri);
    },
  };
}
