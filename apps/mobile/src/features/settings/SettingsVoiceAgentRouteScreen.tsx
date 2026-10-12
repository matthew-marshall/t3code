import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { VOICE_AGENT_VOICES, type VoiceAgentPace } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Alert, Linking, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { saveGeminiKey, useGeminiKeySaved } from "../voice-agent/geminiKey";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const PACE_LABELS: Record<VoiceAgentPace, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
};

const voiceLabel = (name: string) => {
  const voice = VOICE_AGENT_VOICES.find((candidate) => candidate.name === name);
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

const save = (key: string) =>
  saveGeminiKey(key).catch((error: unknown) =>
    Alert.alert(
      "Could not save the key",
      error instanceof Error ? error.message : "The Keychain refused it.",
    ),
  );

function promptForKey(replacing: boolean) {
  Alert.prompt(
    replacing ? "Replace Gemini API key" : "Add Gemini API key",
    "Kept in this phone's Keychain. It is only sent to Google.",
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
}

function GeminiKeySection() {
  const saved = useGeminiKeySaved();
  return (
    <SettingsSection title={saved ? "Gemini API key · Saved" : "Gemini API key"}>
      <SettingsActionRow
        icon="key"
        label={saved ? "Replace key" : "Add key"}
        disabled={saved === null}
        onPress={() => promptForKey(saved === true)}
      />
      {saved ? (
        <SettingsActionRow
          icon="trash"
          label="Remove key"
          tone="danger"
          onPress={() =>
            Alert.alert("Remove the Gemini API key?", "Voice stops working until you add one.", [
              { text: "Cancel", style: "cancel" },
              { text: "Remove", style: "destructive", onPress: () => void save("") },
            ])
          }
        />
      ) : (
        <SettingsActionRow
          icon="arrow.up.right"
          label="Get a key from Google AI Studio"
          onPress={() => void Linking.openURL("https://aistudio.google.com/apikey")}
        />
      )}
    </SettingsSection>
  );
}

/** The voice agent beta: on or off, the Gemini key, and how it sounds. */
export function SettingsVoiceAgentRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const ready = preferences !== null && !preferencesResult.waiting;
  const enabled = preferences?.voiceAgentEnabled === true;
  const voice = preferences?.voiceAgentVoice ?? "";
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
          subtitle="Talk to T3 Code with Gemini Live"
          disabled={!ready}
          value={enabled}
          onValueChange={(value) => savePreferences({ voiceAgentEnabled: value })}
        />
      </SettingsSection>
      <GeminiKeySection />
      {enabled ? (
        <SettingsSection title="Voice">
          <SettingsControlRow icon="speaker.wave.2" label="Voice">
            <ControlPillMenu
              actions={[
                { id: "", title: "Default", state: voice === "" ? "on" : "off" },
                ...VOICE_AGENT_VOICES.map((candidate) => ({
                  id: candidate.name,
                  title: candidate.name,
                  subtitle: candidate.style,
                  state: voice === candidate.name ? ("on" as const) : ("off" as const),
                })),
              ]}
              onPressAction={({ nativeEvent }) =>
                savePreferences({ voiceAgentVoice: nativeEvent.event })
              }
            >
              <MenuValue label="Voice" value={voiceLabel(voice)} disabled={!ready} />
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
        straight from this phone to Google, and Gemini usage is billed to the key&apos;s account.
      </Text>
    </ScrollView>
  );
}
