import type { ReadoutLocation } from "./geminiSpeech.ts";
import type { Readout } from "./readout.ts";
import type { VoiceAgentTool } from "./session.ts";
import { type SpeakableSentence, speakableSentences } from "./speakable.ts";

/** Reading aloud as the tools see it; the session does the reading. */
export interface VoiceAgentReadAloudTools {
  /** Starts reading once the agent is quiet; returns what the agent is told. */
  readonly request: (
    title: string,
    sentences: ReadonlyArray<SpeakableSentence>,
    start?: number,
    end?: number,
  ) => string;
  readonly current: () => Readout | null;
  /** Plays part of the current read-aloud now. */
  readonly play: (start?: number, end?: number) => void;
  /** Gemini Flash-Lite: which sentences a description such as "the conclusion" means. */
  readonly locate: (
    sentences: ReadonlyArray<string>,
    description: string,
  ) => Promise<ReadoutLocation>;
}

/** Where to find the text to read: a thread's message, or a dictation. */
export interface ReadAloudSources {
  /** The `back`th most recent agent message in a thread (1 is the latest), with its title. */
  readonly threadMessage: (
    threadId: string,
    back: number,
  ) => Promise<{ readonly title: string; readonly text: string }>;
  readonly dictation: (
    reference: string,
  ) => { readonly title: string; readonly text: string } | null;
}

const partSchema = {
  type: "string",
  description:
    'A part to read instead of all of it, described as the user put it: "the last paragraph", "the data table", "the conclusion".',
};

const SENTENCE_MARKS: Record<SpeakableSentence["kind"], string> = {
  text: "",
  heading: "[heading] ",
  list: "[list item] ",
  table: "[table] ",
  code: "",
};

const positiveInt = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;

export function createReadAloudTools(
  readAloud: VoiceAgentReadAloudTools,
  sources: ReadAloudSources,
): ReadonlyArray<VoiceAgentTool> {
  // Headings and list items are marked, so the locator can tell where a section ends.
  const locate = async (sentences: ReadonlyArray<SpeakableSentence>, part: string) =>
    readAloud.locate(
      sentences.map((sentence) => `${SENTENCE_MARKS[sentence.kind]}${sentence.text}`),
      part,
    );

  return [
    {
      declaration: {
        name: "read_aloud",
        description:
          'Reads a message aloud word for word, in another voice, so the user hears all of it rather than your summary. Use when they ask to "read it" or hear the details. Pass a thread (its latest agent message by default) or a dictation. Reading pauses when the user speaks.',
        parametersJsonSchema: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "From list_threads." },
            message: {
              type: "integer",
              description: "Which agent message, counting back from the latest (1).",
            },
            dictationId: {
              type: "string",
              description: 'A dictation to read back instead: its ID, or "latest".',
            },
            part: partSchema,
          },
        },
      },
      run: async (args) => {
        const dictationRef = typeof args.dictationId === "string" ? args.dictationId : null;
        const threadId = typeof args.threadId === "string" ? args.threadId : null;
        let source: { readonly title: string; readonly text: string } | null;
        if (dictationRef !== null) {
          source = sources.dictation(dictationRef);
          if (source === null) return `There is no dictation "${dictationRef}".`;
        } else if (threadId !== null) {
          source = await sources.threadMessage(threadId, positiveInt(args.message, 1));
        } else {
          throw new Error("Pass a threadId or a dictationId.");
        }
        const sentences = speakableSentences(source.text);
        const part = typeof args.part === "string" ? args.part.trim() : "";
        if (part === "") return readAloud.request(source.title, sentences);
        const found = await locate(sentences, part);
        if (!found.found) return `Could not find ${part}: ${found.reason}`;
        return readAloud.request(source.title, sentences, found.start, found.end);
      },
    },
    {
      declaration: {
        name: "readout_control",
        description:
          'Controls the message being read aloud, or the last one read. "resume" goes on from where it paused; "back" and "forward" move by sentences; "again" rereads the current paragraph; "find" plays a described part; "code" reads the next code block verbatim; "status" says where it is.',
        parametersJsonSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "resume",
                "pause",
                "stop",
                "back",
                "forward",
                "again",
                "find",
                "code",
                "status",
              ],
            },
            sentences: { type: "integer", description: 'How far "back" or "forward" moves (1).' },
            part: partSchema,
          },
          required: ["action"],
        },
      },
      run: async (args) => {
        const readout = readAloud.current();
        if (readout === null) return "Nothing has been read aloud yet; use read_aloud.";
        const state = readout.getState();
        const steps = positiveInt(args.sentences, 1);
        switch (args.action) {
          case "resume":
            readAloud.play(state.phase === "finished" ? 0 : state.index);
            return "Resuming.";
          case "pause":
            readout.pause();
            return "Paused.";
          case "stop":
            readout.stop();
            return "Stopped.";
          case "back":
            readAloud.play(Math.max(0, state.index - steps));
            return `Back ${steps}.`;
          case "forward":
            readAloud.play(Math.min(state.count - 1, state.index + steps));
            return `Forward ${steps}.`;
          case "again": {
            const block = readout.sentences[state.index]?.block;
            const start = readout.sentences.findIndex((sentence) => sentence.block === block);
            readAloud.play(Math.max(0, start), state.end);
            return "Reading that part again.";
          }
          case "find": {
            const part = typeof args.part === "string" ? args.part.trim() : "";
            if (part === "") throw new Error('"find" needs a part.');
            const found = await locate(readout.sentences, part);
            if (!found.found) return `Could not find ${part}: ${found.reason}`;
            readAloud.play(found.start, found.end);
            return `Reading ${part}.`;
          }
          case "code": {
            const code = readout.sentences.find(
              (sentence, index) => index >= state.index && sentence.kind === "code",
            );
            if (code?.verbatim === undefined) return "There is no code block from here on.";
            const lines = code.verbatim
              .split("\n")
              .filter((line) => line.trim() !== "")
              .map((text) => ({ text, block: 0, kind: "code" as const }));
            return readAloud.request(`${state.title} (code)`, lines);
          }
          case "status":
            return JSON.stringify({
              title: state.title,
              phase: state.phase,
              sentence: state.index + 1,
              of: state.count,
              text: readout.sentences[state.index]?.text ?? "",
            });
          default:
            throw new Error("Unknown action.");
        }
      },
    },
  ];
}
