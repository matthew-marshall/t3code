"use strict";

// Adds the T3PacketTunnel Network Extension (NEPacketTunnelProvider) target and
// embeds it in the app, so the GlobalProtect tunnel can run as a system VPN while
// the app is in the background. The extension links the same prebuilt OCCore
// static library as the T3VpnTunnel pod. The app finds it by bundle id
// `<app bundle id>.packet-tunnel` (see T3VpnTunnelModule.swift).
//
// Packet tunnel providers need a paid team: register this plugin only when
// T3CODE_IOS_PACKET_TUNNEL=1 (see app.config.ts).

const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const TARGET_NAME = "T3PacketTunnel";
const EXTENSION_SOURCE = "modules/t3-vpn-tunnel/extension/PacketTunnelProvider.swift";
// Relative to ios/ (SOURCE_ROOT).
const OCCORE_XCFRAMEWORK = "../modules/t3-vpn-tunnel/Vendor/OCCore.xcframework";
const EMBED_PHASE_NAME = "Embed Foundation Extensions";
const DEPLOYMENT_TARGET = "16.1";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>T3 Code VPN</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.networkextension.packet-tunnel</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).PacketTunnelProvider</string>
  </dict>
</dict>
</plist>
`;

const ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.networking.networkextension</key>
  <array>
    <string>packet-tunnel-provider</string>
  </array>
</dict>
</plist>
`;

const quote = (value) => `"${value}"`;

function withPacketTunnelFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const targetDirectory = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
      fs.mkdirSync(targetDirectory, { recursive: true });
      fs.copyFileSync(
        path.join(cfg.modRequest.projectRoot, EXTENSION_SOURCE),
        path.join(targetDirectory, "PacketTunnelProvider.swift"),
      );
      fs.writeFileSync(path.join(targetDirectory, "Info.plist"), INFO_PLIST);
      fs.writeFileSync(
        path.join(targetDirectory, `${TARGET_NAME}.entitlements`),
        ENTITLEMENTS_PLIST,
      );
      return cfg;
    },
  ]);
}

function addFileReference(project, { name, path: filePath, lastKnownFileType, sourceTree }) {
  const uuid = project.generateUuid();
  const section = project.pbxFileReferenceSection();
  section[uuid] = {
    isa: "PBXFileReference",
    lastKnownFileType,
    ...(name ? { name: quote(name) } : {}),
    path: quote(filePath),
    sourceTree: quote(sourceTree),
  };
  section[`${uuid}_comment`] = name ?? path.basename(filePath);
  return { uuid, basename: name ?? path.basename(filePath) };
}

function addBuildFile(project, fileReference, phaseName, settings) {
  const uuid = project.generateUuid();
  const section = project.pbxBuildFileSection();
  section[uuid] = {
    isa: "PBXBuildFile",
    fileRef: fileReference.uuid,
    fileRef_comment: fileReference.basename,
    ...(settings ? { settings } : {}),
  };
  const comment = `${fileReference.basename} in ${phaseName}`;
  section[`${uuid}_comment`] = comment;
  return { value: uuid, comment };
}

function addBuildPhase(project, target, isa, name, files, extra = {}) {
  const objects = project.hash.project.objects;
  objects[isa] ??= {};
  const uuid = project.generateUuid();
  objects[isa][uuid] = {
    isa,
    buildActionMask: 2147483647,
    ...extra,
    files,
    runOnlyForDeploymentPostprocessing: 0,
  };
  objects[isa][`${uuid}_comment`] = name;
  target.buildPhases.push({ value: uuid, comment: name });
  return objects[isa][uuid];
}

function withPacketTunnelXcodeProject(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    // Idempotent: a non-clean prebuild already has the target.
    if (project.pbxTargetByName(TARGET_NAME)) {
      return cfg;
    }
    const objects = project.hash.project.objects;
    const mainTargetUuid = project.getFirstTarget().uuid;
    const mainTarget = project.pbxNativeTargetSection()[mainTargetUuid];

    const buildSettings = {
      APPLICATION_EXTENSION_API_ONLY: "YES",
      CODE_SIGN_ENTITLEMENTS: quote(`${TARGET_NAME}/${TARGET_NAME}.entitlements`),
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: quote(cfg.ios?.buildNumber ?? "1"),
      ...(cfg.ios?.appleTeamId ? { DEVELOPMENT_TEAM: cfg.ios.appleTeamId } : {}),
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: quote(`${TARGET_NAME}/Info.plist`),
      IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
      LD_RUNPATH_SEARCH_PATHS: [
        quote("$(inherited)"),
        quote("@executable_path/Frameworks"),
        quote("@executable_path/../../Frameworks"),
      ],
      MARKETING_VERSION: quote(cfg.ios?.version ?? cfg.version ?? "1.0"),
      // OCCore is linked by search path rather than as an xcframework file: Xcode copies a linked
      // xcframework's module map into the shared build include folder, where it collides with
      // the T3VpnTunnel pod's copy of the same module for every pod in the app.
      OTHER_LDFLAGS: [
        quote("$(inherited)"),
        quote("-lOCCore"),
        quote("-lxml2"),
        quote("-lz"),
        quote("-liconv"),
      ],
      [quote("LIBRARY_SEARCH_PATHS[sdk=iphoneos*]")]: quote(
        `$(SRCROOT)/${OCCORE_XCFRAMEWORK}/ios-arm64`,
      ),
      [quote("LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]")]: quote(
        `$(SRCROOT)/${OCCORE_XCFRAMEWORK}/ios-arm64-simulator`,
      ),
      [quote("SWIFT_INCLUDE_PATHS[sdk=iphoneos*]")]: quote(
        `$(SRCROOT)/${OCCORE_XCFRAMEWORK}/ios-arm64/Headers`,
      ),
      [quote("SWIFT_INCLUDE_PATHS[sdk=iphonesimulator*]")]: quote(
        `$(SRCROOT)/${OCCORE_XCFRAMEWORK}/ios-arm64-simulator/Headers`,
      ),
      PRODUCT_BUNDLE_IDENTIFIER: quote(`${cfg.ios.bundleIdentifier}.packet-tunnel`),
      PRODUCT_NAME: quote("$(TARGET_NAME)"),
      SKIP_INSTALL: "YES",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: quote("1,2"),
    };
    const configurationList = project.addXCConfigurationList(
      ["Debug", "Release"].map((name) => ({
        isa: "XCBuildConfiguration",
        name,
        buildSettings: { ...buildSettings },
      })),
      "Release",
      `Build configuration list for PBXNativeTarget "${TARGET_NAME}"`,
    );

    const productFile = project.addProductFile(TARGET_NAME, {
      basename: `${TARGET_NAME}.appex`,
      explicitFileType: "wrapper.app-extension",
      includeInIndex: 0,
      sourceTree: "BUILT_PRODUCTS_DIR",
    });
    // The xcode package writes these as the literal string "undefined" for products.
    const productReference = project.pbxFileReferenceSection()[productFile.fileRef];
    delete productReference.fileEncoding;
    delete productReference.lastKnownFileType;

    const targetUuid = project.generateUuid();
    const target = {
      isa: "PBXNativeTarget",
      buildConfigurationList: configurationList.uuid,
      buildPhases: [],
      buildRules: [],
      dependencies: [],
      name: TARGET_NAME,
      productName: TARGET_NAME,
      productReference: productFile.fileRef,
      productType: quote("com.apple.product-type.app-extension"),
    };
    project.addToPbxNativeTargetSection({ uuid: targetUuid, pbxNativeTarget: target });
    project.addToPbxProjectSection({ uuid: targetUuid, pbxNativeTarget: target });

    // Source files live in ios/T3PacketTunnel (written by the dangerous mod).
    const source = addFileReference(project, {
      path: "PacketTunnelProvider.swift",
      lastKnownFileType: "sourcecode.swift",
      sourceTree: "<group>",
    });
    const infoPlist = addFileReference(project, {
      path: "Info.plist",
      lastKnownFileType: "text.plist.xml",
      sourceTree: "<group>",
    });
    const entitlements = addFileReference(project, {
      path: `${TARGET_NAME}.entitlements`,
      lastKnownFileType: "text.plist.entitlements",
      sourceTree: "<group>",
    });
    const networkExtension = addFileReference(project, {
      name: "NetworkExtension.framework",
      path: "System/Library/Frameworks/NetworkExtension.framework",
      lastKnownFileType: "wrapper.framework",
      sourceTree: "SDKROOT",
    });

    const groupUuid = project.generateUuid();
    objects.PBXGroup[groupUuid] = {
      isa: "PBXGroup",
      children: [source, infoPlist, entitlements, networkExtension].map((file) => ({
        value: file.uuid,
        comment: file.basename,
      })),
      path: TARGET_NAME,
      sourceTree: quote("<group>"),
    };
    objects.PBXGroup[`${groupUuid}_comment`] = TARGET_NAME;
    const mainGroupUuid = project.getFirstProject().firstProject.mainGroup;
    objects.PBXGroup[mainGroupUuid].children.push({ value: groupUuid, comment: TARGET_NAME });

    addBuildPhase(project, target, "PBXSourcesBuildPhase", "Sources", [
      addBuildFile(project, source, "Sources"),
    ]);
    addBuildPhase(project, target, "PBXFrameworksBuildPhase", "Frameworks", [
      addBuildFile(project, networkExtension, "Frameworks"),
    ]);
    addBuildPhase(project, target, "PBXResourcesBuildPhase", "Resources", []);

    // expo-widgets and expo-sharing embed into a phase with this same name, so reuse it.
    objects.PBXCopyFilesBuildPhase ??= {};
    const embedPhase =
      mainTarget.buildPhases
        .filter((phase) => phase.comment === EMBED_PHASE_NAME)
        .map((phase) => objects.PBXCopyFilesBuildPhase[phase.value])
        .find(Boolean) ??
      addBuildPhase(project, mainTarget, "PBXCopyFilesBuildPhase", EMBED_PHASE_NAME, [], {
        dstPath: quote(""),
        dstSubfolderSpec: 13,
        name: quote(EMBED_PHASE_NAME),
      });
    embedPhase.files.push(
      addBuildFile(
        project,
        { uuid: productFile.fileRef, basename: productFile.basename },
        EMBED_PHASE_NAME,
        { ATTRIBUTES: ["RemoveHeadersOnCopy"] },
      ),
    );

    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    project.addTargetDependency(mainTargetUuid, [targetUuid]);

    return cfg;
  });
}

module.exports = function withPacketTunnelExtension(config) {
  return withPacketTunnelXcodeProject(withPacketTunnelFiles(config));
};
