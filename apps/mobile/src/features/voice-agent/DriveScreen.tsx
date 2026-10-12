import { voiceAgentStatus } from "@t3tools/client-runtime/voice-agent";
import { Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useVoiceAgentState } from "./VoiceAgentPanel";
import { stopVoiceAgent, toggleVoiceAgent, voiceAgentController } from "./voiceAgentSession";

const BUTTON_MAX = 320;

/**
 * The Drive tab: one target large enough to hit without looking. It starts and ends voice; in
 * push-to-talk it is held while speaking, with a separate control to end.
 */
export function DriveScreen() {
  const state = useVoiceAgentState();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const size = Math.min(BUTTON_MAX, width * 0.7, height * 0.4);
  const active = state.phase === "live" || state.phase === "connecting";
  const holdToTalk = state.mode === "push-to-talk" && state.phase === "live";

  const label =
    state.phase === "error"
      ? "Tap to try again"
      : !active
        ? "Tap to talk"
        : holdToTalk
          ? state.talking
            ? "Listening…"
            : "Hold to talk"
          : voiceAgentStatus(state);
  const lit = state.talking || (active && !holdToTalk && state.phase === "live");

  return (
    <View
      className="flex-1 items-center justify-center gap-6 bg-screen px-6"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 96 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={holdToTalk ? "Hold to talk" : active ? "End voice" : "Start voice"}
        accessibilityState={{ selected: active }}
        className={cn(
          "items-center justify-center gap-3 rounded-full active:opacity-80",
          lit ? "bg-primary" : "bg-subtle-strong",
        )}
        style={{ width: size, height: size }}
        onPress={holdToTalk ? undefined : toggleVoiceAgent}
        onPressIn={holdToTalk ? () => voiceAgentController.beginTalking() : undefined}
        onPressOut={holdToTalk ? () => voiceAgentController.endTalking() : undefined}
      >
        <SymbolView
          name={active && !holdToTalk ? "stop.fill" : "mic"}
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
      {state.phase === "error" ? (
        <Text className="text-center text-base text-danger-foreground" numberOfLines={3}>
          {state.error}
        </Text>
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
