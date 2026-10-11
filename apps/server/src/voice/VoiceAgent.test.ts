import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerThreadToolkit, layerToolCaller } from "../mcp/McpHttpServer.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as VoiceAgent from "./VoiceAgent.ts";

const caller = { sessionId: AuthSessionId.make("voice-test-session") };

interface TokenRequest {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly body: unknown;
}

const layerGemini = (requests: Array<TokenRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          apiKey: request.headers["x-goog-api-key"],
          body:
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined,
        });
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ name: "auth_tokens/voice-test-token" }),
        );
      }),
    ),
  );

// Built separately, as in server.ts: the voice agent must still see the toolkit's tools.
const layerVoice = (
  env: Record<string, string>,
  requests: Array<TokenRequest> = [],
  savedApiKey = "",
) =>
  Layer.mergeAll(layerThreadToolkit, VoiceAgent.layer.pipe(Layer.provide(layerToolCaller))).pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed(
            McpToolAccessTestkit.idleThreadProjection(
              McpToolAccessTestkit.liveThreadShell(threadId),
            ),
          ),
      }),
    ),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("voice-test-environment")),
      }),
    ),
    Layer.provide(layerGemini(requests)),
    Layer.provide(ServerSettings.layerTest({ voiceAgentGeminiApiKey: savedApiKey })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

it.effect("issues a single-use token with every registered tool", () => {
  const requests: Array<TokenRequest> = [];
  return Effect.gen(function* () {
    const voice = yield* VoiceAgent.VoiceAgent;
    const session = yield* voice.createSession;
    expect(session.token).toBe("auth_tokens/voice-test-token");
    expect(session.model).toBe("gemini-3.8-live");
    const names = session.tools.map((tool) => tool.name);
    expect(names).toContain("t3_pending_request_list");
    expect(names).toContain("t3_thread_organize");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.apiKey).toBe("test-gemini-key");
    expect(requests[0]?.body).toMatchObject({ uses: 1 });
  }).pipe(Effect.provide(layerVoice({ GEMINI_API_KEY: "test-gemini-key" }, requests)));
});

it.effect("prefers the key saved in settings over GEMINI_API_KEY", () => {
  const requests: Array<TokenRequest> = [];
  return Effect.gen(function* () {
    const voice = yield* VoiceAgent.VoiceAgent;
    yield* voice.createSession;
    expect(requests[0]?.apiKey).toBe("saved-gemini-key");
  }).pipe(
    Effect.provide(layerVoice({ GEMINI_API_KEY: "env-gemini-key" }, requests, "saved-gemini-key")),
  );
});

it.effect("refuses a session when no Gemini key is configured", () =>
  Effect.gen(function* () {
    const voice = yield* VoiceAgent.VoiceAgent;
    const error = yield* Effect.flip(voice.createSession);
    expect(error.code).toBe("not-configured");
  }).pipe(Effect.provide(layerVoice({}))),
);

it.effect("runs voice tools on the shared MCP server as a client caller", () =>
  Effect.gen(function* () {
    const voice = yield* VoiceAgent.VoiceAgent;
    const result = yield* voice.callTool(caller, {
      name: "t3_pending_request_list",
      arguments: { threadId: ThreadId.make("voice-test-thread") },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({ requestIds: [] });
  }).pipe(Effect.provide(layerVoice({}))),
);

it.effect("returns bad arguments to the model instead of failing", () =>
  Effect.gen(function* () {
    const voice = yield* VoiceAgent.VoiceAgent;
    const result = yield* voice.callTool(caller, {
      name: "t3_pending_request_read",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(layerVoice({}))),
);

it.effect("tells the model about a tool that does not exist", () =>
  Effect.gen(function* () {
    const voice = yield* VoiceAgent.VoiceAgent;
    const result = yield* voice.callTool(caller, { name: "t3_not_a_tool", arguments: {} });
    expect(result).toEqual({ isError: true, output: "Tool 't3_not_a_tool' not found" });
  }).pipe(Effect.provide(layerVoice({}))),
);
