/**
 * Turns a message's markdown into sentences to read aloud one at a time. Seeking and finding
 * parts work in sentence numbers, which stay exact however fast the voice speaks.
 */

export interface SpeakableSentence {
  /** What is spoken. */
  readonly text: string;
  /** Which paragraph, table or code block it belongs to, counting from 0. */
  readonly block: number;
  readonly kind: "text" | "heading" | "list" | "table" | "code";
  /** A code block's source, read only when asked for verbatim. */
  readonly verbatim?: string;
}

const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const BARE_URL = /\bhttps?:\/\/\S+/g;
const EMPHASIS = /(\*\*|__|\*|_|~~|`)/g;

/** Inline markdown as it would be said: link text instead of URLs, no emphasis marks. */
function speakInline(text: string): string {
  return text
    .replace(LINK, "$1")
    .replace(BARE_URL, "a link")
    .replace(EMPHASIS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits prose into sentences, keeping abbreviations like "e.g." and decimals together. */
export function splitSentences(text: string): ReadonlyArray<string> {
  const sentences: Array<string> = [];
  let current = "";
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/u);
  for (const part of parts) {
    current = current === "" ? part : `${current} ${part}`;
    // A short fragment such as "e.g." or "No." is not a sentence of its own.
    if (current.length >= 12 || part === parts.at(-1)) {
      sentences.push(current.trim());
      current = "";
    }
  }
  if (current.trim() !== "") sentences.push(current.trim());
  return sentences.filter((sentence) => sentence !== "");
}

const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => speakInline(cell));

/** One sentence per row, naming each value by its column. */
function speakTable(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  const header = tableCells(lines[0] ?? "");
  const rows = lines.slice(2).map(tableCells);
  const intro = `A table with ${rows.length} ${rows.length === 1 ? "row" : "rows"}: ${header.join(", ")}.`;
  return [
    intro,
    ...rows.map(
      (row, index) =>
        `Row ${index + 1}: ${row
          .map((cell, column) => (header[column] ? `${header[column]}, ${cell}` : cell))
          .join("; ")}.`,
    ),
  ];
}

export function speakableSentences(markdown: string): ReadonlyArray<SpeakableSentence> {
  const sentences: Array<SpeakableSentence> = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let block = 0;
  let paragraph: Array<string> = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    for (const text of splitSentences(speakInline(paragraph.join(" ")))) {
      sentences.push({ text, block, kind: "text" });
    }
    paragraph = [];
    block += 1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      const code: Array<string> = [];
      for (
        index += 1;
        index < lines.length && !lines[index]!.trim().startsWith("```");
        index += 1
      ) {
        code.push(lines[index]!);
      }
      const language = trimmed.slice(3).trim();
      sentences.push({
        text: `A ${code.length}-line ${language ? `${language} ` : ""}code block.`,
        block,
        kind: "code",
        verbatim: code.join("\n"),
      });
      block += 1;
      continue;
    }
    if (trimmed.startsWith("|") && lines[index + 1]?.trim().match(/^\|?[\s:|-]+\|?$/)) {
      flushParagraph();
      const table: Array<string> = [];
      while (index < lines.length && lines[index]!.trim().startsWith("|")) {
        table.push(lines[index]!);
        index += 1;
      }
      index -= 1;
      for (const text of speakTable(table)) sentences.push({ text, block, kind: "table" });
      block += 1;
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushParagraph();
      sentences.push({ text: speakInline(heading[1]!), block, kind: "heading" });
      block += 1;
      continue;
    }
    const item = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushParagraph();
      for (const text of splitSentences(speakInline(item[1]!))) {
        sentences.push({ text, block, kind: "list" });
      }
      // Consecutive items form one block, so "the list" finds all of it.
      if (!lines[index + 1]?.trim().match(/^(?:[-*+]|\d+[.)])\s+/)) block += 1;
      continue;
    }
    if (trimmed === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  return sentences;
}
