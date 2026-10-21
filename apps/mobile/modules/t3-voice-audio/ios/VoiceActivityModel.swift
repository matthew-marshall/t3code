import CoreML
import Foundation

/// Silero VAD v6.2.1 (MIT, github.com/snakers4/silero-vad), converted to Core ML
/// (huggingface.co/aufklarer/Silero-VAD-v6.2.1-CoreML): how likely the audio is someone talking,
/// as opposed to road noise, bumps or the air conditioning, in 32 ms frames of 16 kHz audio.
///
/// One audio stream per instance, fed from one thread. The model keeps LSTM state between frames.
final class VoiceActivityModel {
  static let sampleRate = 16_000.0
  private static let frameSamples = 512
  private static let contextSamples = 64

  private let model: MLModel
  private var hidden: MLMultiArray
  private var cell: MLMultiArray
  /// The previous frame's last samples, which the model reads ahead of each new frame.
  private var context = [Float](repeating: 0, count: contextSamples)
  private var pending: [Float] = []
  private let input: MLMultiArray

  /// Nil when the model is missing from `bundle` or Core ML cannot load it.
  init?(bundle: Bundle) {
    guard let url = bundle.url(forResource: "silero_vad", withExtension: "mlmodelc") else {
      return nil
    }
    let configuration = MLModelConfiguration()
    // A model this small runs fastest on the CPU, and leaves the Neural Engine to dictation.
    configuration.computeUnits = .cpuOnly
    guard let model = try? MLModel(contentsOf: url, configuration: configuration),
      let hidden = Self.zeros([1, 1, 128]),
      let cell = Self.zeros([1, 1, 128]),
      let input = Self.zeros([1, 1, NSNumber(value: Self.contextSamples + Self.frameSamples)])
    else { return nil }
    self.model = model
    self.hidden = hidden
    self.cell = cell
    self.input = input
  }

  private static func zeros(_ shape: [NSNumber]) -> MLMultiArray? {
    guard let array = try? MLMultiArray(shape: shape, dataType: .float16) else { return nil }
    array.withUnsafeMutableBufferPointer(ofType: Float16.self) { buffer, _ in
      for index in buffer.indices { buffer[index] = 0 }
    }
    return array
  }

  /// Takes 16 kHz samples in -1...1 and returns the highest speech probability among the frames
  /// they completed, or nil when they did not complete one.
  func feed(_ samples: UnsafeBufferPointer<Float>) -> Float? {
    pending.append(contentsOf: samples)
    var highest: Float?
    var start = 0
    while pending.count - start >= Self.frameSamples {
      if let probability = predict(pending[start..<start + Self.frameSamples]) {
        highest = max(highest ?? 0, probability)
      }
      start += Self.frameSamples
    }
    pending.removeFirst(start)
    return highest
  }

  private func predict(_ frame: ArraySlice<Float>) -> Float? {
    input.withUnsafeMutableBufferPointer(ofType: Float16.self) { buffer, _ in
      for (index, sample) in context.enumerated() { buffer[index] = Float16(sample) }
      for (offset, sample) in frame.enumerated() {
        buffer[Self.contextSamples + offset] = Float16(sample)
      }
    }
    context = Array(frame.suffix(Self.contextSamples))
    guard
      let features = try? MLDictionaryFeatureProvider(dictionary: [
        "audio": input, "h": hidden, "c": cell,
      ]),
      let output = try? model.prediction(from: features),
      let probability = output.featureValue(for: "probability")?.multiArrayValue,
      let nextHidden = output.featureValue(for: "h_out")?.multiArrayValue,
      let nextCell = output.featureValue(for: "c_out")?.multiArrayValue
    else { return nil }
    hidden = nextHidden
    cell = nextCell
    return probability[0].floatValue
  }
}
