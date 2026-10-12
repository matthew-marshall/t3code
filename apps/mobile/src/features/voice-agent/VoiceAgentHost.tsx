import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom } from "../../state/preferences";
import { parseActiveThreadPath } from "../keyboard/hardwareKeyboardCommands";
import { isVoiceAgentAudioAvailable } from "./nativeVoiceAudio";
import { setVoiceAgentHost, stopVoiceAgent, voiceAgentController } from "./voiceAgentSession";

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
  const voice = settings?.voiceAgentVoice ?? "";
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
  useEffect(() => () => setVoiceAgentHost(null), []);

  useEffect(() => {
    if (!enabled) stopVoiceAgent();
  }, [enabled]);
  useEffect(() => {
    void voiceAgentController.setSpeech({ voice: voice === "" ? null : voice, pace });
  }, [voice, pace]);
  // The saved mode applies once preferences load; later changes come from the panel.
  useEffect(() => {
    if (mode !== undefined) void voiceAgentController.setMode(mode);
  }, [mode]);

  return null;
}
