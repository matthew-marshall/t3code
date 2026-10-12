import { voiceAgentStatus } from "@t3tools/client-runtime/voice-agent";
import { Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useVoiceAgentState } from "./VoiceAgentPanel";
import { stopVoiceAgent, toggleVoiceAgent, voiceAgentController } from "./voiceAgentSession";

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
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const size = Math.min(BUTTON_MAX, width * 0.7, height * 0.4);
  const active = state.phase === "live" || state.phase === "connecting";
  const dictation = state.dictation;
  const holdToTalk = state.mode === "push-to-talk" && state.phase === "live" && dictation === null;

  const label =
    dictation?.phase === "recording"
      ? "Finish dictation"
      : dictation?.phase === "transcribing"
        ? "Transcribing…"
        : state.phase === "error"
          ? "Tap to try again"
          : !active
            ? "Tap to talk"
            : holdToTalk
              ? state.talking
                ? "Listening…"
                : "Hold to talk"
              : voiceAgentStatus(state);
  const lit =
    dictation !== null || state.talking || (active && !holdToTalk && state.phase === "live");
  const onPress =
    dictation?.phase === "recording"
      ? () => voiceAgentController.finishDictation()
      : dictation !== null || holdToTalk
        ? undefined
        : toggleVoiceAgent;
  const heard = dictation?.heard.trim() ?? "";

  return (
    <View
      className="flex-1 items-center justify-center gap-6 bg-screen px-6"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 96 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          dictation !== null
            ? label
            : holdToTalk
              ? "Hold to talk"
              : active
                ? "End voice"
                : "Start voice"
        }
        accessibilityState={{ selected: active, disabled: dictation?.phase === "transcribing" }}
        className={cn(
          "items-center justify-center gap-3 rounded-full active:opacity-80",
          lit ? "bg-primary" : "bg-subtle-strong",
        )}
        style={{ width: size, height: size }}
        onPress={onPress}
        onPressIn={holdToTalk ? () => voiceAgentController.beginTalking() : undefined}
        onPressOut={holdToTalk ? () => voiceAgentController.endTalking() : undefined}
      >
        <SymbolView
          name={dictation !== null || (active && !holdToTalk) ? "stop.fill" : "mic"}
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
      {state.phase === "error" ? (
        <Text className="text-center text-base text-danger-foreground" numberOfLines={3}>
          {state.error}
        </Text>
      ) : null}
      {state.phase === "live" && dictation === null && voiceAgentController.canDictate() ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Records until you press Finish or say stop dictation"
          className="h-16 min-w-56 flex-row items-center justify-center gap-2 rounded-full bg-subtle px-8 active:opacity-70"
          onPress={() => voiceAgentController.startDictation()}
        >
          <SymbolView
            name="text.alignleft"
            size={20}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
          <Text className="text-lg font-t3-medium text-foreground">Dictate</Text>
        </Pressable>
      ) : null}
      {holdToTalk ? (
        <Pressable
          accessibilityRole="button"
          className="h-14 min-w-40 items-center justify-center rounded-full bg-subtle px-8 active:opacity-70"
          onPress={stopVoiceAgent}
        >
          <Text className="text-lg font-t3-medium text-foreground">End</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
