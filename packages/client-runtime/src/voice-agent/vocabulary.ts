import type { EnvironmentProject, EnvironmentThreadShell } from "../state/models.ts";

/**
 * Terms a speech recognizer should expect: names it would otherwise mishear, such as "halfos"
 * heard as "Haiku OS". Gemini 3.5 Transcribe allows 1,000 but does best with about 100.
 */
export const VOICE_VOCABULARY_LIMIT = 100;

/** Common words a recognizer already knows; listing them would crowd out the names. */
const COMMON_WORDS = new Set(
  (
    "a an and are as at be but by can do does for from get has have how if in into is it its " +
    "make new not of off on or our out over per so than that the then this to up use via vs was " +
    "we what when where which while why will with without add adds added fix fixes fixed " +
    "update updates updated remove removes support supports improve improves check test tests " +
    "testing work working run running start stop more less all any some only after before " +
    "first last next back down full other same each again also just still into onto about " +
    "issue issues bug bugs feature features change changes thread threads"
  ).split(" "),
);

/** The user's own list, one term per line or separated by commas. */
export function parseVoiceVocabulary(text: string): ReadonlyArray<string> {
  return text
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter((term) => term !== "");
}

/** Words of a title worth biasing towards: names, codes and jargon, not everyday words. */
function titleWords(title: string): ReadonlyArray<string> {
  return title
    .split(/[\s/,:;()[\]{}"'`|]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[.!?]+$/gu, ""))
    .filter(
      (word) => word.length >= 3 && /\p{L}/u.test(word) && !COMMON_WORDS.has(word.toLowerCase()),
    );
}

/**
 * The user's own terms first, then project names, then words from the active threads' titles,
 * most recently updated first, without repeats, up to `limit`.
 */
export function voiceVocabulary(
  input: {
    readonly custom: ReadonlyArray<string>;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  },
  limit = VOICE_VOCABULARY_LIMIT,
): ReadonlyArray<string> {
  // Hermes has no toSorted; filter returns a new array to sort.
  const active = input.threads
    .filter((thread) => thread.archivedAt === null && thread.settledOverride !== "settled")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const candidates = [
    ...input.custom,
    ...input.projects
      .filter((project) => project.isScratch !== true)
      .map((project) => project.title),
    ...active.flatMap((thread) => titleWords(thread.title)),
  ];
  const seen = new Set<string>();
  const terms: Array<string> = [];
  for (const candidate of candidates) {
    const term = candidate.trim();
    const key = term.toLowerCase();
    if (term === "" || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === limit) break;
  }
  return terms;
}
