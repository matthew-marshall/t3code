import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { AudioLinesIcon, MicIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const LABELS: Record<VoiceInputState["phase"], string> = {
  idle: "Dictate",
  error: "Dictate",
  preparing: "Starting the microphone…",
  recording: "Stop and transcribe",
  transcribing: "Transcribing…",
};

/**
 * The composer's dictation control: starts a recording, then stops it to
 * transcribe. While a recording is open, a second button discards it.
 */
export const ComposerDictationButton = memo(function ComposerDictationButton(props: {
  readonly state: VoiceInputState;
  readonly shortcutLabel: string | null;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  const { phase } = props.state;
  const recording = phase === "recording";
  const busy = phase === "preparing" || phase === "transcribing";
  const label = LABELS[phase];
  return (
    <>
      {recording || busy ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onCancel}
                aria-label="Discard dictation"
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Discard dictation</TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={recording ? "ghost-destructive" : "ghost"}
              size="icon-sm"
              data-composer-shortcut="composer.dictate"
              disabled={busy}
              aria-pressed={recording}
              onPointerDown={(event) => event.preventDefault()}
              onClick={recording ? props.onStop : props.onStart}
              aria-label={label}
            />
          }
        >
          {phase === "transcribing" ? <AudioLinesIcon /> : <MicIcon />}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {label}
          {props.shortcutLabel && !busy ? ` (${props.shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </>
  );
});
