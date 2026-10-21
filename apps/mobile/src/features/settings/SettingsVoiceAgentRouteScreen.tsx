import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  VOICE_AGENT_OPENAI_VOICES,
  VOICE_AGENT_VOICES,
  type VoiceAgentPace,
  type VoiceAgentProviderId,
} from "@t3tools/contracts";
import { parseVoiceVocabulary, type VoiceDictationMode } from "@t3tools/client-runtime/voice-agent";
import { AsyncResult } from "effect/reactivity";
import { Alert, Linking, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { geminiKey, openAIKey, useKeySaved } from "../voice-agent/apiKeys";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const DICTATION_MODE_LABELS: Record<VoiceDictationMode, string> = {
  "gemini-batch": "Gemini",
  "on-device": "On device",
};

const DICTATION_MODE_SUBTITLES: Record<VoiceDictationMode, string> = {
  "gemini-batch": "Transcribed by Gemini at the end, without filler words",
  "on-device": "Free and offline, less accurate",
};

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

/** Past dictations and sessions: to copy a dictation, or see what the agent heard and did. */
function HistorySection() {
  const navigation = useNavigation();
  return (
    <SettingsSection title="History">
      <SettingsRow
        icon="text.alignleft"
        label="Dictations"
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsVoiceDictations" },
          })
        }
      />
      <SettingsRow
        icon="bubble.left.and.bubble.right"
        label="Sessions and tool calls"
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsVoiceSessions" },
          })
        }
      />
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
  const dictationMode = preferences?.voiceAgentDictationMode ?? "gemini-batch";
  const vocabularyCount = parseVoiceVocabulary(preferences?.voiceVocabulary ?? "").length;
  const navigation = useNavigation();

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
        <ListRowLayout
          icon="server.rack"
          label="Provider"
          accessory={
            <Menu
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
            </Menu>
          }
        />
      </SettingsSection>
      <ApiKeySection provider={provider} />
      <HistorySection />
      {enabled ? (
        <SettingsSection title="Voice">
          <ListRowLayout
            icon="speaker.wave.2"
            label="Voice"
            accessory={
              <Menu
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
              </Menu>
            }
          />
          <ListRowLayout
            icon="speedometer"
            label="Speaking pace"
            accessory={
              <Menu
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
              </Menu>
            }
          />
          <SettingsSwitchRow
            icon="speaker.wave.2"
            label="Sound cues"
            subtitle="Blips for tool calls, ticks while the agent works, a tone when the connection drops"
            disabled={!ready}
            value={preferences?.voiceAgentSoundCues !== false}
            onValueChange={(value) => savePreferences({ voiceAgentSoundCues: value })}
          />
          <SettingsRow
            icon="text.word.spacing"
            label="Vocabulary"
            value={vocabularyCount === 0 ? "Automatic" : `${vocabularyCount} of yours`}
            valuePosition="trailing"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsVoiceVocabulary" },
              })
            }
          />
          <ListRowLayout
            icon="text.alignleft"
            label="Dictation"
            accessory={
              <Menu
                actions={(["gemini-batch", "on-device"] as const).map((candidate) => ({
                  id: candidate,
                  title: DICTATION_MODE_LABELS[candidate],
                  subtitle: DICTATION_MODE_SUBTITLES[candidate],
                  state: dictationMode === candidate ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent }) => {
                  const next = nativeEvent.event;
                  if (next === "gemini-batch" || next === "on-device") {
                    savePreferences({ voiceAgentDictationMode: next });
                  }
                }}
              >
                <MenuValue
                  label="Dictation"
                  value={DICTATION_MODE_LABELS[dictationMode]}
                  disabled={!ready}
                />
              </Menu>
            }
          />
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
