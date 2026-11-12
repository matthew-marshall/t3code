import { describe, expect, it } from "vite-plus/test";

import { endsWithStopPhrase, stripStopPhrases } from "./dictation.ts";

describe("dictation stop phrases", () => {
  it("stops on stop dictation or the exact end dictation, but not on its common mishearings", () => {
    expect(endsWithStopPhrase("Ramble, ramble. Stop dictation.")).toBe(true);
    expect(endsWithStopPhrase("ramble end dictation")).toBe(true);
    expect(endsWithStopPhrase("Ramble, ramble. And dictation.")).toBe(false);
    expect(endsWithStopPhrase("Ramble, ramble. In dictation")).toBe(false);
    expect(endsWithStopPhrase("we should stop dictation from cutting off")).toBe(false);
  });

  it("strips the stop phrase and misheard attempts from the end, keeping real words", () => {
    // From a real on-device transcript.
    expect(
      stripStopPhrases(
        "Any other suggestions? And dictation. And dictation. In dictation. Stop dictation.",
      ),
    ).toBe("Any other suggestions?");
    expect(stripStopPhrases("Add a retry to the upload, end dictation.")).toBe(
      "Add a retry to the upload",
    );
    expect(stripStopPhrases("I like the voice and dictation stop dictation")).toBe(
      "I like the voice and dictation",
    );
  });
});
