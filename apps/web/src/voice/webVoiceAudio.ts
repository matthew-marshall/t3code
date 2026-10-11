import { LIVE_OUTPUT_SAMPLE_RATE, type VoiceAgentAudio } from "@t3tools/client-runtime/voice-agent";

import captureWorkletUrl from "./pcmCaptureWorklet.ts?worker&url";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToPcm(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const samples = new Float32Array(binary.length >> 1);
  for (let index = 0; index < samples.length; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const value = (high << 8) | low;
    samples[index] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
  }
  return samples;
}

/**
 * Browser microphone and speaker for a voice session. Capture runs in an
 * AudioWorklet; speech is scheduled back to back on the same AudioContext so
 * the browser's echo cancellation hears what it plays.
 */
export function createWebVoiceAudio(): VoiceAgentAudio & {
  /** Resumes audio inside a user gesture, before the session's async setup. */
  unlock(): void;
} {
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let captureNode: AudioWorkletNode | null = null;
  let playbackTime = 0;
  const playing = new Set<AudioBufferSourceNode>();

  const ensureContext = (): AudioContext => {
    context ??= new AudioContext();
    return context;
  };

  return {
    unlock() {
      void ensureContext().resume();
    },

    async startCapture(onChunk) {
      const audioContext = ensureContext();
      await audioContext.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      await audioContext.audioWorklet.addModule(captureWorkletUrl);
      const source = audioContext.createMediaStreamSource(stream);
      captureNode = new AudioWorkletNode(audioContext, "t3-pcm-capture");
      captureNode.port.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
        onChunk(bytesToBase64(new Uint8Array(event.data)));
      });
      captureNode.port.start();
      source.connect(captureNode);
    },

    async stopCapture() {
      captureNode?.port.close();
      captureNode?.disconnect();
      captureNode = null;
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      stream = null;
      const audioContext = context;
      context = null;
      playing.clear();
      await audioContext?.close();
    },

    play(base64Pcm) {
      const audioContext = ensureContext();
      const samples = base64ToPcm(base64Pcm);
      if (samples.length === 0) {
        return;
      }
      const buffer = audioContext.createBuffer(1, samples.length, LIVE_OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      playbackTime = Math.max(playbackTime, audioContext.currentTime);
      source.start(playbackTime);
      playbackTime += buffer.duration;
      playing.add(source);
      source.addEventListener("ended", () => playing.delete(source), { once: true });
    },

    clearPlayback() {
      for (const source of playing) {
        source.stop();
      }
      playing.clear();
      playbackTime = 0;
    },
  };
}
