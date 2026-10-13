import { describe, expect, it } from "vite-plus/test";

import { speakableSentences, splitSentences } from "./speakable.ts";

describe("speakable sentences", () => {
  it("splits prose into sentences without breaking abbreviations or decimals", () => {
    expect(splitSentences("Version 2.5 shipped. It fixes the upload, e.g. retries. Done?")).toEqual(
      ["Version 2.5 shipped.", "It fixes the upload, e.g. retries.", "Done?"],
    );
  });

  it("reads tables row by row, announces code, and drops markup", () => {
    const sentences = speakableSentences(
      [
        "## Results",
        "",
        "See [the report](https://example.com/r) for **all** details.",
        "",
        "| Board | Status |",
        "| --- | --- |",
        "| halfos | failing |",
        "| lnghost | passing |",
        "",
        "```ts",
        "const a = 1;",
        "const b = 2;",
        "```",
        "",
        "- First point.",
        "- Second point.",
      ].join("\n"),
    );
    expect(sentences.map((sentence) => [sentence.kind, sentence.text])).toEqual([
      ["heading", "Results"],
      ["text", "See the report for all details."],
      ["table", "A table with 2 rows: Board, Status."],
      ["table", "Row 1: Board, halfos; Status, failing."],
      ["table", "Row 2: Board, lnghost; Status, passing."],
      ["code", "A 2-line ts code block."],
      ["list", "First point."],
      ["list", "Second point."],
    ]);
    expect(sentences[5]?.verbatim).toBe("const a = 1;\nconst b = 2;");
    // The table is one block, and so is the list.
    expect(new Set(sentences.filter((s) => s.kind === "table").map((s) => s.block)).size).toBe(1);
    expect(new Set(sentences.filter((s) => s.kind === "list").map((s) => s.block)).size).toBe(1);
  });
});
