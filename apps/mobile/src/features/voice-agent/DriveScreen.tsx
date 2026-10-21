import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { voiceAgentStatus } from "@t3tools/client-runtime/voice-agent";
import { useCallback } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { setDriveScreenShown } from "./driveScreenShown";
import { useTalkGesture } from "./useTalkGesture";
import { useVoiceAgentState } from "./VoiceAgentPanel";
import {
  setVoiceAgentMode,
  startVoiceAgent,
  stopVoiceAgent,
  voiceAgentController,
} from "./voiceAgentSession";

const BUTTON_MAX = 320;
/** Enough of what was heard to see dictation is working, without reading while driving. */
const HEARD_CHARS = 160;

/**
 * The Drive tab: one target large enough to hit without looking. It starts and ends voice; in
 * push-to-talk it is held while speaking, with a separate control to end. While voice is on,
 * Dictate records until it is pressed again, the user says "stop dictation", or a play/pause
 * button (steering wheel, headphones) is pressed.
 */
export function DriveScreen() {
  const state = useVoiceAgentState();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const size = Math.min(BUTTON_MAX, width * 0.7, height * 0.4);
  // The floating voice panel would repeat this screen, so it hides while this is shown.
  useFocusEffect(
    useCallback(() => {
      setDriveScreenShown(true);
      return () => setDriveScreenShown(false);
    }, []),
  );
  const active = state.phase === "live" || state.phase === "connecting";
  const dictation = state.dictation;
  const holdToTalk = state.mode === "push-to-talk" && state.phase === "live" && dictation === null;
  const talk = useTalkGesture(state.talking);

  const label =
    dictation?.phase === "recording"
      ? "Finish dictation"
      : dictation?.phase === "transcribing"
        ? "Transcribing…"
        : !active
          ? "Start voice"
          : state.phase === "connecting"
            ? voiceAgentStatus(state)
            : holdToTalk
              ? state.talking
                ? talk.locked
                  ? "Listening · tap to send"
                  : "Listening · release to send"
                : "Hold or tap to talk"
              : state.muted
                ? "Muted · tap to unmute"
                : "Mic open · tap to mute";
  const lit =
    dictation !== null || state.talking || (state.phase === "live" && !holdToTalk && !state.muted);
  // During a session the big button never ends it: that is the small ✕ above.
  const onPress =
    dictation?.phase === "recording"
      ? () => voiceAgentController.finishDictation()
      : !active
        ? startVoiceAgent
        : state.phase === "live" && dictation === null && !holdToTalk
          ? () => voiceAgentController.setMuted(!state.muted)
          : undefined;
  const heard = dictation?.heard.trim() ?? "";

  return (
    <View
      className="flex-1 items-center justify-center gap-6 bg-screen px-6"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 96 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active, disabled: dictation?.phase === "transcribing" }}
        className={cn(
          "items-center justify-center gap-3 rounded-full active:opacity-80",
          lit ? "bg-primary" : "bg-subtle-strong",
        )}
        style={{ width: size, height: size }}
        onPress={onPress}
        onPressIn={holdToTalk ? talk.onPressIn : undefined}
        onPressOut={holdToTalk ? talk.onPressOut : undefined}
      >
        <SymbolView
          name={dictation !== null ? "stop.fill" : "mic"}
          size={size * 0.28}
          tintColorClassName={lit ? "accent-primary-foreground" : "accent-icon"}
          type="monochrome"
        />
        <Text
          accessibilityLiveRegion="polite"
          className={cn(
            "px-6 text-center text-xl font-t3-medium",
            lit ? "text-primary-foreground" : "text-foreground",
          )}
          numberOfLines={2}
        >
          {label}
        </Text>
      </Pressable>
      {dictation?.phase === "recording" ? (
        <Text className="text-center text-base text-foreground-muted" numberOfLines={3}>
          {heard === ""
            ? "Say “stop dictation” or press play/pause when you are done."
            : `…${heard.slice(-HEARD_CHARS)}`}
        </Text>
      ) : null}
      {state.readout !== null && state.readout.phase !== "finished" ? (
        <View className="items-center gap-3">
          <Text className="text-center text-base text-foreground-muted" numberOfLines={2}>
            {`${state.readout.phase === "reading" ? "Reading" : "Paused"} · ${state.readout.index + 1} of ${state.readout.count} · ${state.readout.title}`}
          </Text>
          <View className="flex-row gap-3">
            <Pressable
              accessibilityRole="button"
              className="h-12 items-center justify-center rounded-full bg-subtle px-6 active:opacity-70"
              onPress={() =>
                state.readout?.phase === "reading"
                  ? voiceAgentController.currentReadout()?.pause()
                  : voiceAgentController.playReadout()
              }
            >
              <Text className="text-base font-t3-medium text-foreground">
                {state.readout.phase === "reading" ? "Pause" : "Resume"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              className="h-12 items-center justify-center rounded-full bg-subtle px-6 active:opacity-70"
              onPress={() => voiceAgentController.currentReadout()?.stop()}
            >
              <Text className="text-base font-t3-medium text-foreground">Stop</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {state.phase === "error" ? (
        <Text className="text-center text-base text-danger-foreground" numberOfLines={3}>
          {state.error}
        </Text>
      ) : null}
      {state.phase === "live" && dictation === null ? (
        <View className="flex-row gap-3">
          {voiceAgentController.canDictate() ? (
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Records until you press Finish or say stop dictation"
              className="h-14 flex-row items-center justify-center gap-2 rounded-full bg-subtle px-6 active:opacity-70"
              onPress={() => voiceAgentController.startDictation()}
            >
              <SymbolView
                name="text.alignleft"
                size={18}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text className="text-lg font-t3-medium text-foreground">Dictate</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: state.mode === "hands-free" }}
            className={cn(
              "h-14 items-center justify-center rounded-full px-6 active:opacity-70",
              state.mode === "hands-free" ? "bg-primary" : "bg-subtle",
            )}
            onPress={() =>
              setVoiceAgentMode(state.mode === "hands-free" ? "push-to-talk" : "hands-free")
            }
          >
            <Text
              className={cn(
                "text-lg font-t3-medium",
                state.mode === "hands-free" ? "text-primary-foreground" : "text-foreground",
              )}
            >
              Hands-free
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View
        className="absolute flex-row items-center justify-between px-5"
        style={{ top: insets.top + 8, left: 0, right: 0 }}
      >
        {active ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="End voice session"
            className="size-9 items-center justify-center rounded-full border border-border active:opacity-70"
            onPress={stopVoiceAgent}
          >
            <SymbolView
              name="xmark"
              size={13}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        ) : (
          <View />
        )}
        <View className="flex-row items-center gap-3">
          <Text className="text-sm text-foreground-muted">
            {state.phase === "live"
              ? "● Connected"
              : state.phase === "connecting"
                ? "Connecting…"
                : "Voice is off"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dictations and sessions"
            className="size-9 items-center justify-center rounded-full border border-border active:opacity-70"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsVoiceDictations" },
              })
            }
          >
            <SymbolView
              name="clock"
              size={15}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
