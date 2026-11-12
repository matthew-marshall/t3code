import {
  DEFAULT_UNIFIED_SETTINGS,
  VOICE_AGENT_OPENAI_VOICES,
  VOICE_AGENT_VOICES,
  type VoiceAgentPace,
  type VoiceAgentProviderId,
} from "@t3tools/contracts";

import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { VoiceAgentApiKeyControl } from "./VoiceAgentApiKeyControl";

const VOICE_AGENT_PACE_LABELS: Record<VoiceAgentPace, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
};

const VOICE_AGENT_PROVIDER_LABELS: Record<VoiceAgentProviderId, string> = {
  gemini: "Gemini Live",
  openai: "OpenAI Realtime",
};

/** Each provider has its own voices, saved to its own setting. */
const VOICE_AGENT_PROVIDER_VOICES: Record<
  VoiceAgentProviderId,
  ReadonlyArray<{ readonly name: string; readonly style: string }>
> = {
  gemini: VOICE_AGENT_VOICES,
  openai: VOICE_AGENT_OPENAI_VOICES,
};

function voiceAgentVoiceLabel(provider: VoiceAgentProviderId, name: string): string {
  if (name === "") return "Default";
  const voice = VOICE_AGENT_PROVIDER_VOICES[provider].find((candidate) => candidate.name === name);
  // OpenAI names its voices in lowercase.
  const display = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  return voice === undefined ? display : `${display} · ${voice.style}`;
}

/** Beta: the live voice agent's settings, on the Voice settings page. */
export function VoiceAgentSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  // Each voice provider keeps its own voice choice; "" is the provider's default.
  const activeVoiceAgentVoice =
    settings.voiceAgentProvider === "openai"
      ? settings.voiceAgentOpenAIVoice
      : settings.voiceAgentVoice;
  const setActiveVoiceAgentVoice = (voice: string) =>
    updateSettings(
      settings.voiceAgentProvider === "openai"
        ? { voiceAgentOpenAIVoice: voice }
        : { voiceAgentVoice: voice },
    );

  return (
    <SettingsSection id="voice-agent-section" title="Voice agent">
      <SettingsRow
        {...searchableSetting("voice-agent")}
        description="Beta. Talk to T3 Code hands-free from the sidebar, using Gemini Live or OpenAI Realtime."
        resetAction={
          settings.voiceAgentEnabled !== DEFAULT_UNIFIED_SETTINGS.voiceAgentEnabled ? (
            <SettingResetButton
              label="voice agent"
              onClick={() =>
                updateSettings({
                  voiceAgentEnabled: DEFAULT_UNIFIED_SETTINGS.voiceAgentEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.voiceAgentEnabled}
            onCheckedChange={(checked) => updateSettings({ voiceAgentEnabled: Boolean(checked) })}
            aria-label="Voice agent"
          />
        }
      />

      {settings.voiceAgentEnabled ? (
        <SettingsRow
          {...searchableSetting("voice-vocabulary")}
          description="Names the voice agent tends to mishear, separated by commas. Project names and words from active thread titles are added automatically."
          resetAction={
            settings.voiceVocabulary !== DEFAULT_UNIFIED_SETTINGS.voiceVocabulary ? (
              <SettingResetButton
                label="voice vocabulary"
                onClick={() =>
                  updateSettings({ voiceVocabulary: DEFAULT_UNIFIED_SETTINGS.voiceVocabulary })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={settings.voiceVocabulary}
              onCommit={(next) => updateSettings({ voiceVocabulary: next })}
              placeholder="halfOS, Novatek, Loki"
              spellCheck={false}
              aria-label="Voice vocabulary"
            />
          }
        />
      ) : null}

      {settings.voiceAgentEnabled ? (
        <SettingsRow
          {...searchableSetting("voice-agent-provider")}
          description="The realtime voice model the agent talks through. Google Search is only available with Gemini Live. Switching mid-conversation starts a fresh session."
          resetAction={
            settings.voiceAgentProvider !== DEFAULT_UNIFIED_SETTINGS.voiceAgentProvider ? (
              <SettingResetButton
                label="voice agent provider"
                onClick={() =>
                  updateSettings({
                    voiceAgentProvider: DEFAULT_UNIFIED_SETTINGS.voiceAgentProvider,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.voiceAgentProvider}
              onValueChange={(value) => {
                if (value === "gemini" || value === "openai") {
                  updateSettings({ voiceAgentProvider: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Voice agent provider">
                <SelectValue>
                  {VOICE_AGENT_PROVIDER_LABELS[settings.voiceAgentProvider]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(["gemini", "openai"] as const).map((provider) => (
                  <SelectItem hideIndicator key={provider} value={provider}>
                    {VOICE_AGENT_PROVIDER_LABELS[provider]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}

      {settings.voiceAgentEnabled && settings.voiceAgentProvider === "gemini" ? (
        <SettingsRow
          {...searchableSetting("voice-agent-api-key")}
          description={
            <>
              Kept on this device and only sent to Google; works with every environment. Get a key
              from{" "}
              <a
                className="underline underline-offset-2"
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer noopener"
              >
                Google AI Studio
              </a>
              .
            </>
          }
          control={<VoiceAgentApiKeyControl key="gemini" provider="gemini" />}
        />
      ) : null}

      {settings.voiceAgentEnabled && settings.voiceAgentProvider === "openai" ? (
        <SettingsRow
          {...searchableSetting("voice-agent-openai-api-key")}
          description={
            <>
              Kept on this device and only sent to OpenAI; works with every environment. Get a key
              from the{" "}
              <a
                className="underline underline-offset-2"
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer noopener"
              >
                OpenAI Platform
              </a>
              .
            </>
          }
          control={<VoiceAgentApiKeyControl key="openai" provider="openai" />}
        />
      ) : null}

      {settings.voiceAgentEnabled ? (
        <>
          <SettingsRow
            {...searchableSetting("voice-agent-voice")}
            description={`The voice the agent speaks with on ${VOICE_AGENT_PROVIDER_LABELS[settings.voiceAgentProvider]}. Changing it mid-conversation reconnects.`}
            resetAction={
              activeVoiceAgentVoice !== "" ? (
                <SettingResetButton
                  label="voice agent voice"
                  onClick={() => setActiveVoiceAgentVoice("")}
                />
              ) : null
            }
            control={
              <Select
                value={activeVoiceAgentVoice}
                onValueChange={(value) => {
                  if (typeof value === "string") setActiveVoiceAgentVoice(value);
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Voice agent voice">
                  <SelectValue>
                    {voiceAgentVoiceLabel(settings.voiceAgentProvider, activeVoiceAgentVoice)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="">
                    {voiceAgentVoiceLabel(settings.voiceAgentProvider, "")}
                  </SelectItem>
                  {VOICE_AGENT_PROVIDER_VOICES[settings.voiceAgentProvider].map((voice) => (
                    <SelectItem hideIndicator key={voice.name} value={voice.name}>
                      {voiceAgentVoiceLabel(settings.voiceAgentProvider, voice.name)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            {...searchableSetting("voice-agent-pace")}
            description="How quickly the agent talks."
            resetAction={
              settings.voiceAgentPace !== DEFAULT_UNIFIED_SETTINGS.voiceAgentPace ? (
                <SettingResetButton
                  label="voice agent speaking pace"
                  onClick={() =>
                    updateSettings({ voiceAgentPace: DEFAULT_UNIFIED_SETTINGS.voiceAgentPace })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.voiceAgentPace}
                onValueChange={(value) => {
                  if (value === "slow" || value === "normal" || value === "fast") {
                    updateSettings({ voiceAgentPace: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Voice agent speaking pace"
                >
                  <SelectValue>{VOICE_AGENT_PACE_LABELS[settings.voiceAgentPace]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(["slow", "normal", "fast"] as const).map((pace) => (
                    <SelectItem hideIndicator key={pace} value={pace}>
                      {VOICE_AGENT_PACE_LABELS[pace]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
