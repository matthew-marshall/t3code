import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom } from "../../state/preferences";
import { parseActiveThreadPath } from "../keyboard/hardwareKeyboardCommands";
import { isVoiceAgentAudioAvailable, onSiriVoiceRequest } from "./nativeVoiceAudio";
import {
  setVoiceAgentHost,
  setVoiceAgentProvider,
  startVoiceAgent,
  stopVoiceAgent,
  voiceAgentController,
} from "./voiceAgentSession";

/**
 * Connects the app-wide voice session to the navigator: the thread on screen,
 * environment names, opening threads, and the voice settings. Renders
 * nothing; hosted in its own leaf so environment updates do not re-render the
 * root layout.
 */
export function VoiceAgentHost(props: { readonly pathname: string }) {
  const linkTo = useLinkTo();
  const { environments } = useEnvironments();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const settings = AsyncResult.isSuccess(preferences) ? preferences.value : null;
  const enabled = isVoiceAgentAudioAvailable && settings?.voiceAgentEnabled === true;
  const provider = settings?.voiceAgentProvider ?? "gemini";
  // Each provider has its own voices, so each keeps its own choice.
  const voice =
    (provider === "openai" ? settings?.voiceAgentOpenAIVoice : settings?.voiceAgentVoice) ?? "";
  const pace = settings?.voiceAgentPace ?? "normal";
  const mode = settings?.voiceAgentMode;

  const threadOnScreen = parseActiveThreadPath(props.pathname);
  const onScreenEnvironmentId = threadOnScreen?.environmentId ?? null;
  const onScreenThreadId = threadOnScreen?.threadId ?? null;
  const labels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the voice session, which outlives screens, what is on screen.
  useEffect(() => {
    setVoiceAgentHost({
      threadOnScreen:
        onScreenEnvironmentId === null || onScreenThreadId === null
          ? null
          : { environmentId: onScreenEnvironmentId, threadId: onScreenThreadId },
      environmentLabel: (environmentId) => labels.get(environmentId) ?? null,
      openThread: (environmentId, threadId) =>
        linkTo(`/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`),
    });
  }, [onScreenEnvironmentId, onScreenThreadId, labels, linkTo]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- detaches the voice session from this host on unmount.
  useEffect(() => () => setVoiceAgentHost(null), []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the live voice connection when the beta is turned off.
  useEffect(() => {
    if (!enabled) stopVoiceAgent();
  }, [enabled]);
  // "Hey Siri, talk to T3". Settings load after a cold launch, so the request waits until then.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Siri's start requests while voice is on.
  useEffect(() => (enabled ? onSiriVoiceRequest(startVoiceAgent) : undefined), [enabled]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- switches the live voice session's provider.
  useEffect(() => {
    setVoiceAgentProvider(provider);
  }, [provider]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the voice and pace to the live voice session.
  useEffect(() => {
    void voiceAgentController.setSpeech({ voice: voice === "" ? null : voice, pace });
  }, [voice, pace]);
  // The saved mode applies once preferences load; later changes come from the panel.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the saved mode to the live voice session once preferences load.
  useEffect(() => {
    if (mode !== undefined) void voiceAgentController.setMode(mode);
  }, [mode]);

  return null;
}
