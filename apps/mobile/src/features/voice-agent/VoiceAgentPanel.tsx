import { voiceAgentStatus, type VoiceAgentState } from "@t3tools/client-runtime/voice-agent";
import { useSyncExternalStore } from "react";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import {
  setVoiceAgentMode,
  startVoiceAgent,
  stopVoiceAgent,
  subscribeVoiceAgent,
  voiceAgentController,
} from "./voiceAgentSession";

// Clears Home's floating bottom toolbar and a collapsed thread composer, like the dictation pill.
const IOS_BOTTOM_CHROME_CLEARANCE = 64;
const PANEL_MAX_WIDTH = 440;
const ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const EXITING = FadeOut.duration(140).reduceMotion(ReduceMotion.System);

const readState = () => voiceAgentController.getState();

export function useVoiceAgentState(): VoiceAgentState {
  return useSyncExternalStore(subscribeVoiceAgent, readState);
}

/**
 * The open voice session, above every screen so it survives navigation:
 * status, mode, the latest words, and a large push-to-talk target that works
 * without looking.
 */
export function VoiceAgentPanel() {
  const state = useVoiceAgentState();
  if (state.phase === "idle") return null;
  const panel = <VoiceAgentPanelContent state={state} />;
  return Platform.OS === "ios" ? <FullWindowOverlay>{panel}</FullWindowOverlay> : panel;
}

function VoiceAgentPanelContent({ state }: { readonly state: VoiceAgentState }) {
  const insets = useSafeAreaInsets();
  const isError = state.phase === "error";
  const pushToTalk = state.mode === "push-to-talk";
  const latest = state.transcript.findLast(
    (entry) => entry.role === "user" || entry.role === "agent",
  );

  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      <View
        pointerEvents="box-none"
        className="absolute items-center"
        style={{
          bottom: Math.max(insets.bottom, 12) + IOS_BOTTOM_CHROME_CLEARANCE,
          left: insets.left + 12,
          right: insets.right + 12,
        }}
      >
        <Animated.View
          entering={ENTERING}
          exiting={EXITING}
          className="w-full gap-2.5 rounded-3xl border border-border bg-card p-3 shadow-md shadow-black/10"
          style={{ maxWidth: PANEL_MAX_WIDTH }}
        >
          <View className="flex-row items-center gap-2">
            <View
              className={cn(
                "size-2 rounded-full",
                isError
                  ? "bg-danger-foreground"
                  : state.phase === "live"
                    ? "bg-primary"
                    : "bg-foreground-muted",
              )}
            />
            <Text
              accessibilityLiveRegion="polite"
              className={cn(
                "min-w-0 flex-1 text-sm",
                isError ? "text-danger-foreground" : "font-t3-medium text-foreground",
              )}
              numberOfLines={2}
            >
              {voiceAgentStatus(state)}
            </Text>
            {isError ? null : (
              <Pressable
                accessibilityLabel={pushToTalk ? "Switch to hands-free" : "Switch to push to talk"}
                accessibilityRole="button"
                className="h-[30px] justify-center rounded-full bg-subtle px-3 active:opacity-70"
                onPress={() => setVoiceAgentMode(pushToTalk ? "hands-free" : "push-to-talk")}
              >
                <Text className="text-xs font-t3-medium text-foreground">
                  {pushToTalk ? "Push to talk" : "Hands-free"}
                </Text>
              </Pressable>
            )}
            <Pressable
              accessibilityLabel="End voice"
              accessibilityRole="button"
              className="size-[30px] items-center justify-center active:opacity-70"
              onPress={stopVoiceAgent}
            >
              <SymbolView
                name="xmark"
                size={13}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </Pressable>
          </View>

          {latest !== undefined && !isError ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={2}>
              {latest.role === "user" ? "You: " : ""}
              {latest.text}
            </Text>
          ) : null}

          {isError ? (
            <Pressable
              accessibilityRole="button"
              className="h-11 items-center justify-center rounded-2xl bg-subtle active:opacity-70"
              onPress={startVoiceAgent}
            >
              <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
            </Pressable>
          ) : pushToTalk ? (
            <Pressable
              accessibilityHint="Hold while you speak"
              accessibilityRole="button"
              accessibilityState={{ disabled: state.phase !== "live" }}
              className={cn(
                "h-14 flex-row items-center justify-center gap-2 rounded-2xl",
                state.talking ? "bg-primary" : "bg-subtle",
                state.phase !== "live" && "opacity-50",
              )}
              disabled={state.phase !== "live"}
              onPressIn={() => voiceAgentController.beginTalking()}
              onPressOut={() => voiceAgentController.endTalking()}
            >
              <SymbolView
                name="mic"
                size={18}
                tintColorClassName={state.talking ? "accent-primary-foreground" : "accent-icon"}
                type="monochrome"
              />
              <Text
                className={cn(
                  "text-base font-t3-medium",
                  state.talking ? "text-primary-foreground" : "text-foreground",
                )}
              >
                {state.talking ? "Listening…" : "Hold to talk"}
              </Text>
            </Pressable>
          ) : null}
        </Animated.View>
      </View>
    </View>
  );
}
