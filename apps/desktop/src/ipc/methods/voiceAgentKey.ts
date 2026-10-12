import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export class DesktopVoiceAgentKeyError extends Schema.TaggedError<DesktopVoiceAgentKeyError>()(
  "DesktopVoiceAgentKeyError",
  {
    operation: Schema.Literals(["read", "decrypt", "encrypt", "write", "remove", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.operation === "unavailable"
      ? "This system has no secure storage for the Gemini API key."
      : `Could not ${this.operation} the saved Gemini API key.`;
  }
}

/**
 * The voice agent's Gemini key, encrypted with the OS keychain through
 * Electron safeStorage. It stays on this machine and out of client settings,
 * which are written as plain JSON.
 */
const keyPath = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return environment.path.join(environment.stateDir, "voice-agent-key.bin");
});

export const getVoiceAgentKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_VOICE_AGENT_KEY_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.voiceAgentKey.get")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const path = yield* keyPath;
    const exists = yield* fileSystem
      .exists(path)
      .pipe(
        Effect.mapError((cause) => new DesktopVoiceAgentKeyError({ operation: "read", cause })),
      );
    if (!exists) return null;
    const encrypted = yield* fileSystem
      .readFile(path)
      .pipe(
        Effect.mapError((cause) => new DesktopVoiceAgentKeyError({ operation: "read", cause })),
      );
    return yield* safeStorage
      .decryptString(encrypted)
      .pipe(
        Effect.mapError((cause) => new DesktopVoiceAgentKeyError({ operation: "decrypt", cause })),
      );
  }),
});

/** An empty key removes the saved one. */
export const setVoiceAgentKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_VOICE_AGENT_KEY_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voiceAgentKey.set")(function* (key) {
    const fileSystem = yield* FileSystem.FileSystem;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const path = yield* keyPath;
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      yield* fileSystem
        .remove(path, { force: true })
        .pipe(
          Effect.mapError((cause) => new DesktopVoiceAgentKeyError({ operation: "remove", cause })),
        );
      return;
    }
    // Fail closed rather than write the key in a form anyone can read.
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!available) {
      return yield* new DesktopVoiceAgentKeyError({ operation: "unavailable" });
    }
    const encrypted = yield* safeStorage
      .encryptString(trimmed)
      .pipe(
        Effect.mapError((cause) => new DesktopVoiceAgentKeyError({ operation: "encrypt", cause })),
      );
    yield* fileSystem
      .writeFile(path, encrypted, { mode: 0o600 })
      .pipe(
        Effect.mapError((cause) => new DesktopVoiceAgentKeyError({ operation: "write", cause })),
      );
  }),
});
