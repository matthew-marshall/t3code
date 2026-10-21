import {
  createGeminiVoiceTranscriber,
  VoiceInputController,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { type RefObject, useEffect, useRef, useState } from "react";

import { readGeminiKey } from "./voiceAgentKeys";
import { createWebVoiceRecorder } from "./webVoiceRecorder";
import { currentVoiceVocabulary } from "./voiceVocabulary";

type Selection = { readonly start: number; readonly end: number };

interface ComposerDictationTarget {
  /** The draft the recording is for; changing it discards a recording in progress. */
  readonly ownerKey: string;
  readonly readText: () => string;
  /** Prompt-string offsets of the editor selection, or null when the editor is not mounted. */
  readonly readSelection: () => Selection | null;
  /** Writes the draft with the transcript inserted, caret at `selection.end`. */
  readonly commit: (text: string, selection: Selection) => void;
}

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

function createDictationController(
  latest: RefObject<ComposerDictationTarget>,
  onStateChange: (state: VoiceInputState) => void,
): VoiceInputController {
  let controller: VoiceInputController | null = null;
  const recording = createWebVoiceRecorder((status) => {
    void controller?.handleRecorderStatus(status);
  });
  const transcriber = createGeminiVoiceTranscriber({
    readApiKey: readGeminiKey,
    readRecording: recording.readRecording,
    locale: navigator.language,
    vocabulary: currentVoiceVocabulary,
  });
  controller = new VoiceInputController({
    recorder: recording.recorder,
    getTranscriber: () => transcriber,
    requestPermission: recording.requestPermission,
    configureRecording: async () => {},
    releaseRecording: recording.release,
    deleteRecording: recording.deleteRecording,
    readDraft: () => {
      const current = latest.current;
      const text = current.readText();
      return {
        ownerKey: current.ownerKey,
        text,
        selection: current.readSelection() ?? { start: text.length, end: text.length },
        // The editor is read-only while dictating, so the text alone shows a draft changed.
        revision: 0,
      };
    },
    commitDraft: (text, selection) => latest.current.commit(text, selection),
    onStateChange,
  });
  return controller;
}

/**
 * Dictation for one composer: records with the browser, transcribes with
 * Gemini 3.5 Transcribe (which drops filler words) and inserts the text where
 * the selection was when recording started. The shared controller keeps one
 * recording active across the app and discards a transcript whose draft changed.
 */
export function useComposerDictation(target: ComposerDictationTarget) {
  // The controller outlives renders and reads the latest target through this.
  const latest = useRef(target);
  const [state, setState] = useState(IDLE);
  // Created on first use, so a composer nobody dictates into sets up nothing.
  const controllerRef = useRef<VoiceInputController | null>(null);
  const controller = () => (controllerRef.current ??= createDictationController(latest, setState));

  useEffect(() => {
    const ownerChanged = latest.current.ownerKey !== target.ownerKey;
    latest.current = target;
    // A recording belongs to the draft it started in; switching drafts discards it.
    if (ownerChanged) controllerRef.current?.ownerChanged();
  });
  useEffect(() => () => controllerRef.current?.dispose(), []);

  return {
    state,
    start: () => void controller().start(),
    /** Stops recording and transcribes what was said. */
    stop: () => void controller().stop(),
    cancel: () => controller().cancel(),
  };
}
