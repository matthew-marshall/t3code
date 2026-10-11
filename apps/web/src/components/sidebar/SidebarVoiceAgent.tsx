import type { VoiceAgentState } from "@t3tools/client-runtime/voice-agent";
import { MicIcon, MicOffIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { useVoiceAgent } from "~/voice/VoiceAgentProvider";
import { Button } from "../ui/button";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function voiceStatus(state: VoiceAgentState): string {
  switch (state.phase) {
    case "idle":
      return "Voice off";
    case "connecting":
      return "Connecting…";
    case "error":
      return state.error ?? "Voice stopped.";
    case "live":
      if (state.runningTools.length > 0) return "Working…";
      if (state.agentSpeaking) return "Speaking";
      if (state.talking || state.mode === "hands-free") return "Listening";
      return "Hold to talk";
  }
}

/** Sidebar utility button that starts and stops the voice session. */
export const SidebarVoiceAgentButton = memo(function SidebarVoiceAgentButton() {
  const voice = useVoiceAgent();
  if (voice === null) {
    return null;
  }
  const active = voice.state.phase === "live" || voice.state.phase === "connecting";
  const label = active ? "Stop voice" : "Start voice";
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              aria-pressed={active}
              isActive={active}
              onClick={active ? voice.handle.stop : voice.handle.start}
              size="icon"
            >
              {active ? <MicIcon /> : <MicOffIcon />}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
});

/** Status, mode, push-to-talk and recent transcript while a voice session is open. */
export const SidebarVoiceAgentPanel = memo(function SidebarVoiceAgentPanel() {
  const voice = useVoiceAgent();
  if (voice === null || voice.state.phase === "idle") {
    return null;
  }
  const { handle, state } = voice;
  const recent = state.transcript.filter((entry) => entry.role !== "tool").slice(-3);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={
            state.phase === "error"
              ? "min-w-0 flex-1 truncate text-destructive-foreground"
              : "min-w-0 flex-1 truncate text-muted-foreground"
          }
          aria-live="polite"
        >
          {voiceStatus(state)}
        </span>
        <Button aria-label="Stop voice" onClick={handle.stop} size="icon-xs" variant="ghost-muted">
          <XIcon />
        </Button>
      </div>
      {state.phase === "error" ? (
        <Button onClick={handle.start} size="compact" variant="outline">
          Try again
        </Button>
      ) : (
        <>
          <ToggleGroup
            aria-label="Voice mode"
            className="w-full *:flex-1"
            value={[state.mode]}
            onValueChange={(next) => {
              const mode = next[0];
              if (mode === "push-to-talk" || mode === "hands-free") handle.setMode(mode);
            }}
          >
            <Toggle size="compact" value="push-to-talk">
              Push to talk
            </Toggle>
            <Toggle size="compact" value="hands-free">
              Hands-free
            </Toggle>
          </ToggleGroup>
          {state.mode === "push-to-talk" ? (
            <Button
              disabled={state.phase !== "live"}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                handle.controller.beginTalking();
              }}
              onPointerUp={() => handle.controller.endTalking()}
              onPointerCancel={() => handle.controller.endTalking()}
              onKeyDown={(event) => {
                if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                  event.preventDefault();
                  handle.controller.beginTalking();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") handle.controller.endTalking();
              }}
              variant={state.talking ? "default" : "outline"}
            >
              <MicIcon />
              {state.talking ? "Listening…" : "Hold to talk"}
            </Button>
          ) : null}
        </>
      )}
      {recent.length > 0 ? (
        <ul className="flex flex-col gap-1 text-muted-foreground">
          {recent.map((entry) => (
            <li key={entry.id} className="line-clamp-2">
              <span className="text-foreground">
                {entry.role === "user" ? "You" : entry.role === "agent" ? "T3" : "Update"}:
              </span>{" "}
              {entry.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
