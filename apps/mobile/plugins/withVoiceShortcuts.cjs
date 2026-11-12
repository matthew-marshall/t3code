"use strict";

// Adds the voice agent's Siri shortcut ("Talk to T3") to the app target. App Shortcuts are read
// from the app binary itself, so the intent cannot live in the T3VoiceAudio pod with the rest of
// voice; the pod only picks up the request (see StartVoiceAgentIntent.swift).

const fs = require("fs");
const path = require("path");
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const FILE = "StartVoiceAgentIntent.swift";
const SOURCE = path.join(__dirname, "..", "modules", "t3-voice-audio", "shortcuts", FILE);

function withShortcutFile(config) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      const target = path.join(cfg.modRequest.platformProjectRoot, projectName, FILE);
      fs.copyFileSync(SOURCE, target);
      return cfg;
    },
  ]);
}

function withShortcutSource(config) {
  return withXcodeProject(config, (cfg) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    const filepath = `${projectName}/${FILE}`;
    if (!cfg.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: projectName,
        project: cfg.modResults,
      });
    }
    return cfg;
  });
}

module.exports = function withVoiceShortcuts(config) {
  return withShortcutSource(withShortcutFile(config));
};
