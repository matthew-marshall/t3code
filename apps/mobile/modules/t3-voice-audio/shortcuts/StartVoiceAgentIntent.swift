import AppIntents
import Foundation

/// "Hey Siri, talk to T3": opens the app and starts a voice session. Added to the app target by
/// plugins/withVoiceShortcuts.cjs, since App Shortcuts must live in the app itself.
@available(iOS 17.0, *)
struct StartVoiceAgentIntent: AppIntent {
  static let title: LocalizedStringResource = "Start voice"
  static let description = IntentDescription("Opens T3 Code and starts talking to the voice agent.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    // Left for T3VoiceAudio to pick up when the app was not running, and announced for when it was.
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "t3.voice.startRequestedAt")
    NotificationCenter.default.post(name: Notification.Name("T3VoiceStartRequested"), object: nil)
    return .result()
  }
}

@available(iOS 17.0, *)
struct T3VoiceShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartVoiceAgentIntent(),
      phrases: [
        "Talk to \(.applicationName)",
        "Start \(.applicationName) voice",
        "Start voice in \(.applicationName)",
      ],
      shortTitle: "Start voice",
      systemImageName: "waveform"
    )
  }
}
