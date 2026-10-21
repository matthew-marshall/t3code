import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { parseVoiceVocabulary, VOICE_VOCABULARY_LIMIT } from "@t3tools/client-runtime/voice-agent";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { automaticVoiceVocabulary } from "../voice-agent/voiceVocabulary";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Names the voice agent and Gemini dictation should expect. The user's own terms come first;
 * project names and words from active thread titles fill the rest.
 */
export function SettingsVoiceVocabularyRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.voiceVocabulary ?? "")
    : null;
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved ?? "";
  // Saved when editing ends, and on leaving the screen in case it did not.
  const save = () => {
    if (draft !== null) savePreferences({ voiceVocabulary: draft });
  };
  const unsaved = useRef<string | null>(null);
  useEffect(() => {
    unsaved.current = draft;
  }, [draft]);
  useEffect(
    () => () => {
      if (unsaved.current !== null) savePreferences({ voiceVocabulary: unsaved.current });
    },
    [savePreferences],
  );

  const [automatic, setAutomatic] = useState<ReadonlyArray<string>>([]);
  useFocusEffect(useCallback(() => setAutomatic(automaticVoiceVocabulary()), []));
  const own = new Set(parseVoiceVocabulary(text).map((term) => term.toLowerCase()));
  const added = automatic.filter((term) => !own.has(term.toLowerCase()));

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <SettingsSection title="Your terms">
        <View className="px-4 py-3">
          <TextInput
            accessibilityLabel="Your terms"
            value={text}
            onChangeText={setDraft}
            onEndEditing={save}
            editable={saved !== null}
            multiline
            scrollEnabled
            autoCapitalize="none"
            autoCorrect={false}
            textAlignVertical="top"
            placeholder={"One per line, or separated by commas:\nhalfOS\nNovatek\nLoki"}
            placeholderTextColorClassName="accent-foreground-muted"
            className="max-h-60 min-h-28 font-sans text-base text-foreground"
          />
        </View>
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Names, product codes and jargon that voice tends to mishear. They go to Gemini Live and
        OpenAI Realtime with each conversation, and to Gemini with each dictation.
      </Text>
      <SettingsSection title="Added automatically">
        <Text selectable className="px-4 py-3 text-sm text-foreground-muted">
          {added.length === 0
            ? "Project names and words from active thread titles appear here."
            : added.join(" · ")}
        </Text>
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {`Project names and words from your active threads' titles, newest first. Up to ${VOICE_VOCABULARY_LIMIT} terms are used in all, your own first.`}
      </Text>
    </ScrollView>
  );
}
