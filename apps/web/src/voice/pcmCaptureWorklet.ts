/**
 * AudioWorklet that turns microphone input into 16 kHz mono 16-bit PCM and
 * posts it in 100 ms chunks, off the main thread. Loaded by `webVoiceAudio.ts`.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const TARGET_RATE = 16_000;
const CHUNK_SAMPLES = TARGET_RATE / 10;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly step = sampleRate / TARGET_RATE;
  private position = 0;
  private sum = 0;
  private count = 0;
  private chunk = new Int16Array(CHUNK_SAMPLES);
  private length = 0;

  process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
    const channel = inputs[0]?.[0];
    if (channel === undefined) {
      return true;
    }
    for (const sample of channel) {
      // Averaging each output sample's span is a cheap low-pass before decimating.
      this.sum += sample;
      this.count += 1;
      this.position += 1;
      if (this.position < this.step) {
        continue;
      }
      this.position -= this.step;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.chunk[this.length++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.length === CHUNK_SAMPLES) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(CHUNK_SAMPLES);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor("t3-pcm-capture", PcmCaptureProcessor);
