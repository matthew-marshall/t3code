import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import {
  nativeVpnTunnel,
  type SystemVpnState,
  type VpnTunnelState,
} from "../vpn-tunnel/nativeVpnTunnel";
import {
  isIPv4Address,
  loadVpnTunnelConfig,
  parseGpclientCookieOutput,
  retryTunnelConnections,
  saveVpnTunnelConfig,
  type VpnTunnelConfig,
} from "../vpn-tunnel/vpnTunnel";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { useEnvironments } from "../../state/environments";
import { useWorkstationProbe } from "../vpn-tunnel/useWorkstationProbe";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const systemVpnAvailable = nativeVpnTunnel?.systemVpnAvailable === true;

const MAX_LOG_LINES = 300;

/**
 * Configures the GlobalProtect tunnel. Environments whose host and port match the target connect
 * through it: the in-app tunnel, or with "Keep connected in the background" a system VPN that
 * routes only the target.
 */
export function SettingsVpnTunnelRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [saved, setSaved] = useState<VpnTunnelConfig | null>(null);
  const [portal, setPortal] = useState("");
  const [cookieOutput, setCookieOutput] = useState("");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("3773");
  const [serverCertPin, setServerCertPin] = useState("");
  const [os, setOs] = useState("linux");
  const [background, setBackground] = useState(false);
  const [systemState, setSystemState] = useState<SystemVpnState>("stopped");
  const [state, setState] = useState<{ state: VpnTunnelState; detail?: string }>(() => ({
    state: nativeVpnTunnel?.getState().state ?? "stopped",
  }));
  const [log, setLog] = useState<ReadonlyArray<string>>(() => nativeVpnTunnel?.getLog() ?? []);

  // Reload on focus so a finished sign-in shows up when returning from the login screen.
  useFocusEffect(
    useCallback(() => {
      void loadVpnTunnelConfig().then((config) => {
        if (config === null) return;
        setSaved(config);
        setPortal(config.portal ?? "");
        setTargetHost(config.targetHost);
        setTargetPort(String(config.targetPort));
        setServerCertPin(config.serverCertPin ?? "");
        setOs(config.os);
        setBackground(config.background === true);
      });
      if (systemVpnAvailable && nativeVpnTunnel !== null) {
        void nativeVpnTunnel.getSystemState().then(setSystemState);
      }
    }, []),
  );

  const usingSystemVpn = systemVpnAvailable && saved?.background === true;
  const probe = useWorkstationProbe(saved);
  const { environments } = useEnvironments();
  // The environments whose address is the workstation, so they connect through this tunnel.
  const tunnelEnvironments =
    saved === null
      ? []
      : environments.filter((environment) =>
          (environment.displayUrl ?? "").includes(`${saved.targetHost}:${saved.targetPort}`),
        );
  // The extension keeps its own log; read it when the system VPN changes state.
  useEffect(() => {
    // Mid-connect the extension has little to say; read it once it settles.
    if (!usingSystemVpn || systemState === "connecting" || nativeVpnTunnel === null) return;
    void nativeVpnTunnel.getSystemLog().then((lines) => {
      if (lines.length > 0) setLog(lines);
    });
  }, [usingSystemVpn, systemState]);

  useEffect(() => {
    if (nativeVpnTunnel === null) return;
    const stateSub = nativeVpnTunnel.addListener("onState", (event) => setState(event));
    const systemSub = systemVpnAvailable
      ? nativeVpnTunnel.addListener("onSystemState", (event) => setSystemState(event.state))
      : null;
    const logSub = nativeVpnTunnel.addListener("onLog", (event) =>
      setLog((lines) => [...lines, event.message].slice(-MAX_LOG_LINES)),
    );
    return () => {
      stateSub.remove();
      systemSub?.remove();
      logSub.remove();
    };
  }, []);

  /** Saves the form; resolves false (after alerting) when it is incomplete. */
  const save = async (inBackground = background): Promise<boolean> => {
    const parsed = parseGpclientCookieOutput(cookieOutput);
    const port = Number(targetPort);
    if (targetHost.trim() === "" || !Number.isInteger(port) || port <= 0 || port > 65535) {
      Alert.alert("Missing workstation", "Enter the workstation's host and T3 port.");
      return false;
    }
    if (inBackground && !isIPv4Address(targetHost.trim())) {
      Alert.alert(
        "Workstation address needed",
        "The background VPN routes one address, so enter the workstation as an IPv4 address.",
      );
      return false;
    }
    const config: VpnTunnelConfig = {
      ...(portal.trim() ? { portal: portal.trim() } : {}),
      gateway: parsed?.gateway ?? saved?.gateway ?? "",
      cookie: parsed?.cookie ?? saved?.cookie ?? "",
      targetHost: targetHost.trim(),
      targetPort: port,
      os: os.trim() || "linux",
      ...(serverCertPin.trim() ? { serverCertPin: serverCertPin.trim() } : {}),
      ...(inBackground ? { background: true } : {}),
    };
    await saveVpnTunnelConfig(config);
    setSaved(config);
    setCookieOutput("");
    setLog([]);
    return true;
  };

  const signIn = async () => {
    if (portal.trim() === "") {
      Alert.alert("Missing portal", "Enter your GlobalProtect portal address.");
      return;
    }
    if (!(await save())) return;
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsVpnTunnelLogin" },
    });
  };

  const remove = () => {
    void saveVpnTunnelConfig(null).then(() => setSaved(null));
  };

  // The pin is only printed while no pin is set; surface it so it can be copied in.
  const offeredPin = log
    .map((line) => line.match(/Pin: (pin-sha256:\S+)/)?.[1])
    .findLast((pin) => pin !== undefined);

  return (
    <SettingsScreen title="VPN Tunnel">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Status">
          <View className="gap-1 px-2">
            <Text className="text-foreground">
              {usingSystemVpn
                ? systemState === "stopped"
                  ? "Background VPN idle · starts when the app connects to the workstation"
                  : `Background VPN ${systemState}`
                : state.state === "stopped" && !state.detail
                  ? "Idle · starts when the app connects to the workstation"
                  : `${state.state}${state.detail ? ` · ${state.detail}` : ""}`}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {saved === null
                ? "Not configured"
                : saved.cookie === ""
                  ? "Not signed in"
                  : `${saved.targetHost}:${saved.targetPort} via ${saved.gateway}`}
            </Text>
            {saved !== null ? (
              <Text className="text-sm text-foreground-muted">
                {`Workstation: ${
                  probe.kind === "ok"
                    ? `answering · ${probe.ms} ms (HTTP ${probe.status})`
                    : probe.kind === "failed"
                      ? `not answering · ${probe.error}`
                      : probe.reason
                }`}
              </Text>
            ) : null}
            {tunnelEnvironments.map((environment) => (
              <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                {`T3 · ${environment.label}: ${connectionStatusText(environment.connection)}`}
              </Text>
            ))}
          </View>
          {saved !== null ? (
            <SettingsActionRow
              icon="arrow.clockwise"
              label="Retry connections now"
              onPress={retryTunnelConnections}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="Connection">
          <ConnectionFormField
            label="GlobalProtect portal"
            value={portal}
            onChangeText={setPortal}
            placeholder="vpn.example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <ConnectionFormField
            label="Workstation host"
            value={targetHost}
            onChangeText={setTargetHost}
            placeholder="10.1.2.3"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ConnectionFormField
            label="T3 port"
            value={targetPort}
            onChangeText={setTargetPort}
            keyboardType="number-pad"
          />
        </SettingsSection>

        <SettingsSection>
          <SettingsActionRow
            icon={{ ios: "person.badge.key", android: "lock" }}
            label="Sign in"
            onPress={() => void signIn()}
          />
          <SettingsActionRow icon="checkmark.circle" label="Save" onPress={() => void save()} />
          {saved !== null ? (
            <SettingsActionRow icon="trash" label="Remove" tone="danger" onPress={remove} />
          ) : null}
        </SettingsSection>

        {systemVpnAvailable ? (
          <SettingsSection title="Background">
            <SettingsSwitchRow
              icon={{ ios: "lock.shield", android: "lock" }}
              label="Keep connected in the background"
              subtitle="Runs as a system VPN that carries only the workstation, so T3 stays connected while closed"
              value={background}
              onValueChange={(value) => {
                setBackground(value);
                if (saved !== null) {
                  void save(value).then((ok) => {
                    if (!ok) setBackground(!value);
                  });
                }
              }}
            />
          </SettingsSection>
        ) : null}

        <SettingsSection title="Advanced">
          <ConnectionFormField
            label="Reported OS"
            value={os}
            onChangeText={setOs}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ConnectionFormField
            label="Gateway certificate pin (optional)"
            value={serverCertPin}
            onChangeText={setServerCertPin}
            placeholder={offeredPin ?? "pin-sha256:…"}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ConnectionFormField
            label="Or paste gpclient connect --cookie-only output"
            value={cookieOutput}
            onChangeText={setCookieOutput}
            placeholder={"COOKIE='…'\nHOST='…'"}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
        </SettingsSection>

        {log.length > 0 ? (
          <SettingsSection title="Log">
            <Text selectable className="px-2 font-mono text-2xs text-foreground-muted">
              {log.join("\n")}
            </Text>
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
