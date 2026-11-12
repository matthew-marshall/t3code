import { parseVoiceVocabulary, voiceVocabulary } from "@t3tools/client-runtime/voice-agent";

import { getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShells } from "~/state/entities";
import { environmentProjects } from "~/state/projects";

/**
 * Names voice and dictation should expect: the user's own terms from Settings, project names and
 * words from active thread titles, as of now.
 */
export function currentVoiceVocabulary(): ReadonlyArray<string> {
  return voiceVocabulary({
    custom: parseVoiceVocabulary(getClientSettings().voiceVocabulary),
    projects: appAtomRegistry.get(environmentProjects.projectsAtom),
    threads: readThreadShells(),
  });
}
