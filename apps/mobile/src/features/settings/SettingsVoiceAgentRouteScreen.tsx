import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  VOICE_AGENT_OPENAI_VOICES,
  VOICE_AGENT_VOICES,
  type VoiceAgentPace,
  type VoiceAgentProviderId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { shareAsync } from "expo-sharing";
import { Alert, Linking, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { geminiKey, openAIKey, useKeySaved } from "../voice-agent/apiKeys";
import { voiceSessionLogs } from "../voice-agent/voiceSessionLog";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const PACE_LABELS: Record<VoiceAgentPace, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
};

/** What differs per provider in these settings. */
const PROVIDERS = {
  gemini: {
    label: "Gemini Live",
    company: "Google",
    key: geminiKey,
    keyName: "Gemini API key",
    keyUrl: "https://aistudio.google.com/apikey",
    keySource: "Google AI Studio",
    voices: VOICE_AGENT_VOICES,
  },
  openai: {
    label: "OpenAI Realtime",
    company: "OpenAI",
    key: openAIKey,
    keyName: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
    keySource: "the OpenAI platform",
    voices: VOICE_AGENT_OPENAI_VOICES,
  },
} as const;

type ProviderSettings = (typeof PROVIDERS)[VoiceAgentProviderId];

const voiceLabel = (provider: ProviderSettings, name: string) => {
  const voice = provider.voices.find((candidate) => candidate.name === name);
  return voice === undefined ? "Default" : `${voice.name} · ${voice.style}`;
};

function MenuValue(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.label}, ${props.value}`}
      accessibilityRole="button"
      className="flex-row items-center gap-1.5 active:opacity-70"
      disabled={props.disabled}
    >
      <Text className="text-base text-foreground-muted">{props.value}</Text>
      <SymbolView
        name="chevron.up.chevron.down"
        size={12}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

function ApiKeySection(props: { readonly provider: ProviderSettings }) {
  const { provider } = props;
  const saved = useKeySaved(provider.key);
  const save = (key: string) =>
    provider.key
      .save(key)
      .catch((error: unknown) =>
        Alert.alert(
          "Could not save the key",
          error instanceof Error ? error.message : "The Keychain refused it.",
        ),
      );
  const promptForKey = () =>
    Alert.prompt(
      saved ? `Replace ${provider.keyName}` : `Add ${provider.keyName}`,
      `Kept in this phone's Keychain. It is only sent to ${provider.company}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: (value?: string) => {
            if (value !== undefined && value.trim().length > 0) void save(value);
          },
        },
      ],
      "secure-text",
    );
  return (
    <SettingsSection title={saved ? `${provider.keyName} · Saved` : provider.keyName}>
      <SettingsActionRow
        icon="key"
        label={saved ? "Replace key" : "Add key"}
        disabled={saved === null}
        onPress={promptForKey}
      />
      {saved ? (
        <SettingsActionRow
          icon="trash"
          label="Remove key"
          tone="danger"
          onPress={() =>
            Alert.alert(
              `Remove the ${provider.keyName}?`,
              `${provider.label} stops working until you add one.`,
              [
                { text: "Cancel", style: "cancel" },
                { text: "Remove", style: "destructive", onPress: () => void save("") },
              ],
            )
          }
        />
      ) : (
        <SettingsActionRow
          icon="arrow.up.right"
          label={`Get a key from ${provider.keySource}`}
          onPress={() => void Linking.openURL(provider.keyUrl)}
        />
      )}
    </SettingsSection>
  );
}

/** Shares the newest voice session log: what the agent heard, said, called and got back. */
function SessionLogSection() {
  const share = () => {
    const latest = voiceSessionLogs()[0];
    if (latest === undefined) {
      Alert.alert("No voice sessions yet", "Logs are kept for the last 20 voice sessions.");
      return;
    }
    void shareAsync(latest.uri, { mimeType: "application/json", UTI: "public.plain-text" }).catch(
      (error: unknown) =>
        Alert.alert(
          "Could not share the log",
          error instanceof Error ? error.message : "Sharing failed.",
        ),
    );
  };
  return (
    <SettingsSection title="Session logs">
      <SettingsActionRow icon="doc.text" label="Share latest session log" onPress={share} />
    </SettingsSection>
  );
}

/** The voice agent beta: on or off, which provider and its key, and how it sounds. */
export function SettingsVoiceAgentRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const ready = preferences !== null && !preferencesResult.waiting;
  const enabled = preferences?.voiceAgentEnabled === true;
  const providerId = preferences?.voiceAgentProvider ?? "gemini";
  const provider = PROVIDERS[providerId];
  const voice =
    (providerId === "openai" ? preferences?.voiceAgentOpenAIVoice : preferences?.voiceAgentVoice) ??
    "";
  const saveVoice = (next: string) =>
    savePreferences(
      providerId === "openai" ? { voiceAgentOpenAIVoice: next } : { voiceAgentVoice: next },
    );
  const pace = preferences?.voiceAgentPace ?? "normal";

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <SettingsSection title="Beta">
        <SettingsSwitchRow
          icon="waveform"
          label="Voice agent"
          subtitle={`Talk to T3 Code with ${provider.label}`}
          disabled={!ready}
          value={enabled}
          onValueChange={(value) => savePreferences({ voiceAgentEnabled: value })}
        />
        <SettingsControlRow icon="server.rack" label="Provider">
          <ControlPillMenu
            actions={(["gemini", "openai"] as const).map((candidate) => ({
              id: candidate,
              title: PROVIDERS[candidate].label,
              state: providerId === candidate ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => {
              const next = nativeEvent.event;
              if (next === "gemini" || next === "openai") {
                savePreferences({ voiceAgentProvider: next });
              }
            }}
          >
            <MenuValue label="Provider" value={provider.label} disabled={!ready} />
          </ControlPillMenu>
        </SettingsControlRow>
      </SettingsSection>
      <ApiKeySection provider={provider} />
      {enabled ? <SessionLogSection /> : null}
      {enabled ? (
        <SettingsSection title="Voice">
          <SettingsControlRow icon="speaker.wave.2" label="Voice">
            <ControlPillMenu
              actions={[
                { id: "", title: "Default", state: voice === "" ? "on" : "off" },
                ...provider.voices.map((candidate) => ({
                  id: candidate.name,
                  title: candidate.name,
                  subtitle: candidate.style,
                  state: voice === candidate.name ? ("on" as const) : ("off" as const),
                })),
              ]}
              onPressAction={({ nativeEvent }) => saveVoice(nativeEvent.event)}
            >
              <MenuValue label="Voice" value={voiceLabel(provider, voice)} disabled={!ready} />
            </ControlPillMenu>
          </SettingsControlRow>
          <SettingsControlRow icon="speedometer" label="Speaking pace">
            <ControlPillMenu
              actions={(["slow", "normal", "fast"] as const).map((candidate) => ({
                id: candidate,
                title: PACE_LABELS[candidate],
                state: pace === candidate ? ("on" as const) : ("off" as const),
              }))}
              onPressAction={({ nativeEvent }) => {
                const next = nativeEvent.event;
                if (next === "slow" || next === "normal" || next === "fast") {
                  savePreferences({ voiceAgentPace: next });
                }
              }}
            >
              <MenuValue label="Speaking pace" value={PACE_LABELS[pace]} disabled={!ready} />
            </ControlPillMenu>
          </SettingsControlRow>
        </SettingsSection>
      ) : null}
      <Text className="px-2 text-sm text-foreground-muted">
        {enabled
          ? "Tap the waveform at the top of the thread list to start. Voice keeps going with the screen locked, and uses a connected car or headset microphone by your Microphone settings."
          : "Turn this on to talk to T3 Code hands-free, such as while driving."}
      </Text>
      <Text className="px-2 text-sm text-foreground-muted">
        Voice works with every environment you are connected to, with no setup on them. Audio goes
        straight from this phone to {provider.company}, and usage is billed to the key&apos;s
        account.
        {providerId === "openai"
          ? " Google Search is only available with Gemini. Dictation still uses the Gemini key."
          : ""}
      </Text>
    </ScrollView>
  );
}
