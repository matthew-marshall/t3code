import { VoiceAgentProviderId } from "@t3tools/contracts";
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
    provider: VoiceAgentProviderId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const name = PROVIDER_KEY_NAMES[this.provider];
    return this.operation === "unavailable"
      ? `This system has no secure storage for the ${name}.`
      : `Could not ${this.operation} the saved ${name}.`;
  }
}

const PROVIDER_KEY_NAMES: Record<VoiceAgentProviderId, string> = {
  gemini: "Gemini API key",
  openai: "OpenAI API key",
};

/**
 * The voice agent's API keys, one per provider, encrypted with the OS keychain
 * through Electron safeStorage. They stay on this machine and out of client
 * settings, which are written as plain JSON. The Gemini key keeps its original
 * file name so keys saved before OpenAI support still load.
 */
const keyPath = (provider: VoiceAgentProviderId) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.path.join(
      environment.stateDir,
      provider === "openai" ? "voice-agent-openai-key.bin" : "voice-agent-key.bin",
    );
  });

/** Absent means Gemini, the voice agent's original provider. */
export const getVoiceAgentKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_VOICE_AGENT_KEY_CHANNEL,
  payload: Schema.UndefinedOr(VoiceAgentProviderId),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.voiceAgentKey.get")(function* (requested) {
    const provider = requested ?? "gemini";
    const fail = (operation: "read" | "decrypt") => (cause: unknown) =>
      new DesktopVoiceAgentKeyError({ operation, provider, cause });
    const fileSystem = yield* FileSystem.FileSystem;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const path = yield* keyPath(provider);
    const exists = yield* fileSystem.exists(path).pipe(Effect.mapError(fail("read")));
    if (!exists) return null;
    const encrypted = yield* fileSystem.readFile(path).pipe(Effect.mapError(fail("read")));
    return yield* safeStorage.decryptString(encrypted).pipe(Effect.mapError(fail("decrypt")));
  }),
});

/** An empty key removes the saved one. An absent provider means Gemini. */
export const setVoiceAgentKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_VOICE_AGENT_KEY_CHANNEL,
  payload: Schema.Struct({
    key: Schema.String,
    provider: Schema.optional(VoiceAgentProviderId),
  }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voiceAgentKey.set")(function* (input) {
    const provider = input.provider ?? "gemini";
    const fail = (operation: "encrypt" | "write" | "remove") => (cause: unknown) =>
      new DesktopVoiceAgentKeyError({ operation, provider, cause });
    const fileSystem = yield* FileSystem.FileSystem;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const path = yield* keyPath(provider);
    const trimmed = input.key.trim();
    if (trimmed.length === 0) {
      yield* fileSystem.remove(path, { force: true }).pipe(Effect.mapError(fail("remove")));
      return;
    }
    // Fail closed rather than write the key in a form anyone can read.
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!available) {
      return yield* new DesktopVoiceAgentKeyError({ operation: "unavailable", provider });
    }
    const encrypted = yield* safeStorage
      .encryptString(trimmed)
      .pipe(Effect.mapError(fail("encrypt")));
    yield* fileSystem
      .writeFile(path, encrypted, { mode: 0o600 })
      .pipe(Effect.mapError(fail("write")));
  }),
});
