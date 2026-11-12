import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject, EnvironmentThreadShell } from "../state/models.ts";
import { parseVoiceVocabulary, voiceVocabulary } from "./vocabulary.ts";

const project = (title: string, isScratch?: true) =>
  ({ title, ...(isScratch ? { isScratch } : {}) }) as unknown as EnvironmentProject;
const thread = (
  title: string,
  updatedAt: string,
  extra: Partial<Pick<EnvironmentThreadShell, "archivedAt" | "settledOverride">> = {},
) =>
  ({
    title,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    ...extra,
  }) as EnvironmentThreadShell;

describe("voice vocabulary", () => {
  it("lists the user's terms, then project names, then names from active thread titles", () => {
    expect(
      voiceVocabulary({
        custom: ["Loki", "halfOS"],
        projects: [project("halfos"), project("amlogic"), project("Scratch", true)],
        threads: [
          thread("Fix the HDMI path on Novatek", "2026-10-20T10:00:00Z"),
          thread("MTK5583 512MB Memory Optimization", "2026-10-21T10:00:00Z"),
          thread("Old perfetto spike", "2026-10-21T11:00:00Z", { settledOverride: "settled" }),
          thread("Archived zram work", "2026-10-21T12:00:00Z", { archivedAt: "2026-10-21" }),
        ],
      }),
    ).toEqual([
      "Loki",
      // A project name the user already listed is not repeated.
      "halfOS",
      "amlogic",
      // The most recently updated thread first; everyday words are left out.
      "MTK5583",
      "512MB",
      "Memory",
      "Optimization",
      "HDMI",
      "path",
      "Novatek",
    ]);
  });

  it("stops at the limit", () => {
    expect(voiceVocabulary({ custom: ["a1", "b2", "c3"], projects: [], threads: [] }, 2)).toEqual([
      "a1",
      "b2",
    ]);
  });

  it("reads the user's list one per line or separated by commas", () => {
    expect(parseVoiceVocabulary("Loki, halfOS\n\n  Novatek \n")).toEqual([
      "Loki",
      "halfOS",
      "Novatek",
    ]);
  });
});
