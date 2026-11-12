/**
 * AudioWorklet that turns microphone input into mono 16-bit PCM at the
 * provider's rate (`processorOptions.targetRate`, 16 kHz for Gemini and 24 kHz
 * for OpenAI) and posts it in 100 ms chunks, off the main thread. Loaded by
 * `webVoiceAudio.ts`.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  constructor(options?: { readonly processorOptions?: { readonly targetRate?: number } });
  readonly port: MessagePort;
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly step: number;
  private readonly chunkSamples: number;
  private position = 0;
  private sum = 0;
  private count = 0;
  private chunk: Int16Array<ArrayBuffer>;
  private length = 0;

  constructor(options: { readonly processorOptions?: { readonly targetRate?: number } }) {
    super(options);
    const targetRate = options.processorOptions?.targetRate ?? 16_000;
    this.step = sampleRate / targetRate;
    this.chunkSamples = Math.round(targetRate / 10);
    this.chunk = new Int16Array(this.chunkSamples);
  }

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
      if (this.length === this.chunkSamples) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(this.chunkSamples);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor("t3-pcm-capture", PcmCaptureProcessor);
