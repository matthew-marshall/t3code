import { useNavigation } from "@react-navigation/native";
import * as Network from "expo-network";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import {
  GP_WEBVIEW_USER_AGENT,
  readGpCallback,
  readSamlResultFromHtml,
  type SamlCredential,
} from "../vpn-tunnel/globalProtect";
import { signInToGlobalProtect } from "../vpn-tunnel/signIn";
import { loadGpProfile, loadVpnTunnelConfig, saveVpnTunnelConfig } from "../vpn-tunnel/vpnTunnel";
import { SettingsScreen } from "./components/SettingsScreen";

// Runs after every main-frame load; GlobalProtect puts the SAML result in the final page.
const POST_PAGE_HTML =
  "window.ReactNativeWebView.postMessage(document.documentElement.outerHTML); true;";

interface SamlPrompt {
  readonly request: string;
  readonly server: string;
  readonly resolve: (credential: SamlCredential) => void;
  readonly reject: (error: unknown) => void;
}

/** Signs in to GlobalProtect (SAML in an embedded browser) and saves the gateway cookie. */
export function SettingsVpnTunnelLoginRouteScreen() {
  const navigation = useNavigation();
  const [prompt, setPrompt] = useState<SamlPrompt | null>(null);
  const [status, setStatus] = useState("Contacting portal…");
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<SamlPrompt | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const config = await loadVpnTunnelConfig();
      if (config?.portal === undefined)
        throw new Error("Enter a portal in Settings → VPN Tunnel first.");
      const result = await signInToGlobalProtect({
        server: config.portal,
        profile: await loadGpProfile(),
        clientIp: await Network.getIpAddressAsync().catch(() => undefined),
        log: (message) => !cancelled && setStatus(message),
        authenticate: (request, server) =>
          new Promise<SamlCredential>((resolve, reject) => {
            const next: SamlPrompt = {
              request,
              server,
              resolve: (credential) => {
                promptRef.current = null;
                setPrompt(null);
                setStatus("Finishing sign-in…");
                resolve(credential);
              },
              reject,
            };
            promptRef.current = next;
            setPrompt(next);
          }),
      });
      if (cancelled) return;
      await saveVpnTunnelConfig({
        ...config,
        gateway: result.gateway,
        cookie: result.cookie,
        signedInAt: Date.now(),
      });
      navigation.goBack();
    };
    run().catch((cause: unknown) => {
      if (cancelled) return;
      setPrompt(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      promptRef.current?.reject(new Error("Sign-in cancelled."));
    };
  }, [navigation]);

  const handleResult = (read: () => SamlCredential | null) => {
    const current = promptRef.current;
    if (current === null) return;
    try {
      const credential = read();
      if (credential !== null) current.resolve(credential);
    } catch (cause) {
      promptRef.current = null;
      current.reject(cause);
    }
  };

  return (
    <SettingsScreen title="VPN Sign In">
      {prompt !== null ? (
        <WebView
          key={prompt.request}
          source={
            prompt.request.startsWith("http")
              ? { uri: prompt.request }
              : { html: prompt.request, baseUrl: prompt.server }
          }
          userAgent={GP_WEBVIEW_USER_AGENT}
          originWhitelist={["*"]}
          setSupportMultipleWindows={false}
          injectedJavaScript={POST_PAGE_HTML}
          onMessage={(event) => handleResult(() => readSamlResultFromHtml(event.nativeEvent.data))}
          onShouldStartLoadWithRequest={(request) => {
            if (!request.url.startsWith("globalprotectcallback:")) return true;
            handleResult(() => readGpCallback(request.url));
            return false;
          }}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          {error === null ? <ActivityIndicator /> : null}
          <Text className="text-center text-foreground">{error ?? status}</Text>
        </View>
      )}
    </SettingsScreen>
  );
}
