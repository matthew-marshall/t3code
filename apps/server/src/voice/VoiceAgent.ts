import {
  type AuthSessionId,
  type VoiceAgentCallToolInput,
  VoiceAgentError,
  type VoiceAgentCallToolResult,
  type VoiceAgentFunctionDeclaration,
  type VoiceAgentSession,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

/** Tool output is read aloud or summarized; past this it only costs latency. */
const MAX_TOOL_OUTPUT_CHARS = 6_000;

const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";
const GEMINI_LIVE_CONSTRAINED_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const DEFAULT_VOICE_MODEL = "gemini-3.8-live";

const SYSTEM_INSTRUCTION = `You are the voice interface for T3 Code, an app that runs coding agents (Codex, Claude, Cursor and others) in threads inside projects. The user is talking to you hands-free, often while driving or running, so:
- Keep replies to one or two short spoken sentences. Never read out code, file paths, IDs, or long lists; summarize instead.
- Use the tools to see and act on projects and threads. Refer to threads and projects by their titles, never by ID.
- To start new work, find the project with t3_project_list, then call t3_thread_launch with a short title and the user's request as the message. Leave out modelSelection to use the project's default model; if the user names a provider or model, check orchestrator_capabilities for its exact instanceId and model.
- To follow up on existing work, find the thread with t3_thread_search or t3_thread_list, then use t3_thread_send.
- Agents sometimes wait for approval or answers. Check t3_pending_request_list when asked what needs attention.
- You have no T3 thread of your own: tools that default to "this thread" need an explicit thread.
- Before anything that cannot be undone, or approving an agent's request, say what you are about to do and wait for the user to confirm.
- If a request is ambiguous, ask one short clarifying question instead of guessing.
Messages that start with "[T3 update]" come from the app, not the user: mention them briefly when relevant.`;

const AuthTokenResponse = Schema.Struct({ name: Schema.String });

export class VoiceAgent extends Context.Service<
  VoiceAgent,
  {
    /** Issues a single-use Gemini Live token and the tools the session may call. */
    readonly createSession: Effect.Effect<VoiceAgentSession, VoiceAgentError>;
    /** Runs one of the session's tool calls as a client caller of this environment's MCP tools. */
    readonly callTool: (
      caller: { readonly sessionId: AuthSessionId },
      input: VoiceAgentCallToolInput,
    ) => Effect.Effect<VoiceAgentCallToolResult, VoiceAgentError>;
  }
>()("t3/voice/VoiceAgent") {}

const truncate = (output: string): string =>
  output.length > MAX_TOOL_OUTPUT_CHARS
    ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[truncated]`
    : output;

const make = Effect.gen(function* () {
  const toolCaller = yield* McpHttpServer.McpToolCaller;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const envApiKey = yield* Config.Redacted("GEMINI_API_KEY").pipe(Config.option);
  const model = yield* Config.String("T3CODE_VOICE_MODEL").pipe(
    Config.withDefault(DEFAULT_VOICE_MODEL),
  );

  const declarations = (): ReadonlyArray<VoiceAgentFunctionDeclaration> =>
    toolCaller.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.inputSchema,
    }));

  const requestToken = Effect.fn("VoiceAgent.requestToken")(function* (key: Redacted.Redacted) {
    const now = yield* DateTime.now;
    const body = {
      uses: 1,
      expireTime: DateTime.formatIso(DateTime.add(now, { minutes: 30 })),
      newSessionExpireTime: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
    };
    return yield* httpClient
      .execute(
        HttpClientRequest.post(`${GEMINI_API_ORIGIN}/v1beta/auth_tokens`).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(key)),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthTokenResponse)),
        Effect.timeout(Duration.seconds(15)),
        Effect.map((response) => response.name),
        Effect.mapError((cause) => new VoiceAgentError({ code: "token-request-failed", cause })),
      );
  });

  const createSession = Effect.gen(function* () {
    // The key saved in settings wins; GEMINI_API_KEY is the fallback for headless servers.
    const savedKey = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.voiceAgentGeminiApiKey),
      Effect.mapError((cause) => new VoiceAgentError({ code: "not-configured", cause })),
    );
    const apiKey = savedKey.length > 0 ? Option.some(Redacted.make(savedKey)) : envApiKey;
    if (Option.isNone(apiKey)) {
      return yield* new VoiceAgentError({ code: "not-configured" });
    }
    const token = yield* requestToken(apiKey.value);
    return {
      token,
      websocketUrl: GEMINI_LIVE_CONSTRAINED_URL,
      model,
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: declarations(),
    };
  }).pipe(Effect.withSpan("VoiceAgent.createSession"));

  const callTool = Effect.fn("VoiceAgent.callTool")(function* (
    caller: { readonly sessionId: AuthSessionId },
    input: VoiceAgentCallToolInput,
  ) {
    yield* Effect.annotateCurrentSpan("voice.tool", input.name);
    const issuedAt = yield* Clock.currentTimeMillis;
    // The same shape MCP OAuth clients get: no thread of its own, and threads it
    // starts are capped at approval-required.
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId,
      requestNamespace: `voice:${caller.sessionId}`,
      thread: undefined,
      client: { sessionId: caller.sessionId, label: "Voice", access: "approval-required" },
      capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
      issuedAt,
    };
    const result = yield* toolCaller.callTool(scope, input);
    return { isError: result.isError, output: truncate(result.text) };
  });

  return VoiceAgent.of({ createSession, callTool });
});

export const layer = Layer.effect(VoiceAgent, make);
