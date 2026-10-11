import { describe, expect, it } from "vite-plus/test";

import {
  GpError,
  normalizeServer,
  parseGatewayLogin,
  parsePortalConfig,
  parsePrelogin,
  portalCookieCredential,
  readGpCallback,
  readSamlResultFromHtml,
  selectGateway,
  serialFromUuid,
} from "./globalProtect";

const SAML_PRELOGIN = `<?xml version="1.0" encoding="UTF-8"?>
<prelogin-response>
  <status>Success</status>
  <msg></msg>
  <saml-default-browser>yes</saml-default-browser>
  <saml-auth-status>0</saml-auth-status>
  <saml-auth-method>REDIRECT</saml-auth-method>
  <saml-request>${btoa("https://idp.example.com/sso?SAMLRequest=abc")}</saml-request>
  <region>US</region>
</prelogin-response>`;

const PORTAL_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<policy>
  <gateways>
    <internal><list><entry name="10.0.0.1"><priority>1</priority></entry></list></internal>
    <external>
      <list>
        <entry name="gw-far.example.com">
          <priority-rule><entry name="Any"><priority>5</priority></entry></priority-rule>
          <priority>1</priority>
          <description>Far</description>
        </entry>
        <entry name="gw-us.example.com">
          <priority-rule>
            <entry name="US"><priority>1</priority></entry>
            <entry name="Any"><priority>9</priority></entry>
          </priority-rule>
          <priority>3</priority>
          <description>US East</description>
        </entry>
      </list>
    </external>
  </gateways>
  <portal-userauthcookie>portal-cookie-123</portal-userauthcookie>
  <portal-prelogonuserauthcookie>empty</portal-prelogonuserauthcookie>
</policy>`;

const GATEWAY_LOGIN = `<?xml version="1.0" encoding="utf-8"?>
<jnlp>
  <application-desc>
    <argument>(null)</argument>
    <argument>auth/cookie+1</argument>
    <argument>persistent</argument>
    <argument>GP-Gateway-N</argument>
    <argument>jane</argument>
    <argument>AD_Authentication</argument>
    <argument>vsys1</argument>
    <argument>corp.example.com</argument>
    <argument>(null)</argument>
    <argument></argument>
    <argument></argument>
    <argument></argument>
    <argument>tunnel</argument>
    <argument>-1</argument>
    <argument>4100</argument>
    <argument>10.9.8.7</argument>
    <argument>xxxxxx</argument>
    <argument>aaaaaa</argument>
    <argument></argument>
  </application-desc>
</jnlp>`;

describe("globalProtect", () => {
  it("normalizes portal input to an https origin", () => {
    expect(normalizeServer("vpn.example.com")).toBe("https://vpn.example.com");
    expect(normalizeServer("https://vpn.example.com:8443/global-protect/")).toBe(
      "https://vpn.example.com:8443",
    );
  });

  it("decodes a SAML prelogin and rejects password-only portals", () => {
    expect(parsePrelogin(SAML_PRELOGIN, "portal")).toEqual({
      samlRequest: "https://idp.example.com/sso?SAMLRequest=abc",
      region: "US",
    });
    expect(() =>
      parsePrelogin("<prelogin-response><status>Success</status></prelogin-response>", "portal"),
    ).toThrow(/only SAML/);
    expect(() =>
      parsePrelogin(
        "<prelogin-response><status>Error</status><msg>Portal down</msg></prelogin-response>",
        "portal",
      ),
    ).toThrow("Portal down");
  });

  it("reads the SAML result embedded in the final page", () => {
    const html =
      "<html><!-- <saml-auth-status>1</saml-auth-status><prelogin-cookie>pc-123456</prelogin-cookie><saml-username>jane@corp</saml-username><saml-slo>no</saml-slo> --></html>";
    expect(readSamlResultFromHtml(html)).toEqual({
      username: "jane@corp",
      preloginCookie: "pc-123456",
    });
    expect(readSamlResultFromHtml("<html><body>Signing in…</body></html>")).toBeNull();
    expect(() =>
      readSamlResultFromHtml("<html><!-- <saml-auth-status>-1</saml-auth-status> --></html>"),
    ).toThrow(GpError);
  });

  it("reads globalprotectcallback results", () => {
    const encoded = btoa(
      "<saml-auth-status>1</saml-auth-status><portal-userauthcookie>ua-cookie-1</portal-userauthcookie><saml-username>jane</saml-username>",
    );
    expect(readGpCallback(`globalprotectcallback:${encoded}`)).toEqual({
      username: "jane",
      portalUserauthcookie: "ua-cookie-1",
    });
    // Decoded twice like gpapi (URL-decode, then form-parse), so %2B ends up as a space.
    expect(readGpCallback("globalprotectcallback:/cas-as=1&un=jane&token=tok%2Fabc")).toEqual({
      username: "jane",
      token: "tok/abc",
    });
  });

  it("parses external gateways and prefers region rules over plain priority", () => {
    const config = parsePortalConfig(PORTAL_CONFIG, "portal.example.com");
    expect(config.gateways.map((gateway) => [gateway.address, gateway.priority])).toEqual([
      ["gw-far.example.com", 1],
      ["gw-us.example.com", 3],
    ]);
    expect(selectGateway(config.gateways, "US").address).toBe("gw-us.example.com");
    expect(selectGateway(config.gateways, "DE").address).toBe("gw-far.example.com");
    expect(portalCookieCredential("jane", config)).toEqual({
      username: "jane",
      portalUserauthcookie: "portal-cookie-123",
    });
  });

  it("falls back to the portal as the only gateway", () => {
    const config = parsePortalConfig("<policy></policy>", "portal.example.com");
    expect(config.gateways).toEqual([
      { name: "portal.example.com", address: "portal.example.com", priority: 0, rules: [] },
    ]);
    expect(portalCookieCredential("jane", config)).toBeNull();
  });

  it("builds the openconnect cookie from a gateway login", () => {
    expect(parseGatewayLogin(GATEWAY_LOGIN, "t3-phone")).toBe(
      "authcookie=auth%2Fcookie%2B1&persistent-cookie=persistent&portal=GP-Gateway-N&user=jane&domain=corp.example.com&preferred-ip=10.9.8.7&computer=t3-phone",
    );
    expect(() => parseGatewayLogin('var respStatus = "Challenge";', "t3-phone")).toThrow(
      /one-time password/,
    );
    expect(() => parseGatewayLogin('<jnlp status="error"></jnlp>', "t3-phone")).toThrow(GpError);
  });

  it("derives the VMware-style serial the Linux client sends", () => {
    expect(serialFromUuid("5a784d56-6461-19ac-9ea9-d36a3b9c6cef")).toBe(
      "VMware-56 4d 78 5a 61 64 ac 19-9e a9 d3 6a 3b 9c 6c ef",
    );
  });
});
