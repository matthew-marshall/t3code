/**
 * GlobalProtect portal/gateway authentication, ported from GlobalProtect-openconnect's
 * `gpclient connect --cookie-only` (crates/gpapi). It identifies as the Linux client,
 * which matches the openconnect "linux" reported OS the tunnel uses.
 *
 * Flow: prelogin -> SAML (in a WebView) -> portal getconfig -> pick gateway ->
 * gateway login -> openconnect cookie.
 */
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

import { childPath, childrenNamed, findFirst, firstText, parseXml, type XmlNode } from "./gpXml";

const CLIENT_VER = "4100";
const CLIENT_GP_VERSION = "6.3.3-619";
const OS_VERSION = "Linux Ubuntu 24.04.3 LTS";
/** base64 of {"cas_embedded_browser":"yes"} */
const CAS_DATA = "eyJjYXNfZW1iZWRkZWRfYnJvd3NlciI6InllcyJ9";

export interface GpProfile {
  readonly hostId: string;
  readonly computer: string;
}

export const GP_API_USER_AGENT = `PAN GlobalProtect/${CLIENT_GP_VERSION} (${OS_VERSION})`;
export const GP_WEBVIEW_USER_AGENT = `${GP_API_USER_AGENT} Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/602.1 (KHTML, like Gecko) PanGPUI Version/10.0 Safari/602.1`;

export type GpErrorKind = "portal" | "auth" | "gateway" | "unsupported";

export class GpError extends Error {
  constructor(
    readonly kind: GpErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface SamlCredential {
  readonly username: string;
  readonly preloginCookie?: string;
  readonly portalUserauthcookie?: string;
  readonly portalPrelogonUserauthcookie?: string;
  readonly token?: string;
}

export type SamlPrelogin = { readonly samlRequest: string; readonly region: string };

/** `https://host[:port]` for a user-entered portal or gateway. */
export function normalizeServer(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  return `https://${url.host}`;
}

function hostOf(server: string): string {
  return new URL(server).host;
}

/** VMware-style serial derived from a UUID, matching gpapi's fallback when no DMI serial exists. */
export function serialFromUuid(uuid: string): string {
  const parts = uuid.toLowerCase().split("-");
  const reverse = (hex: string) => [...hex.match(/../g)!].reverse().join("");
  const compact = [
    reverse(parts[0]!),
    reverse(parts[1]!),
    reverse(parts[2]!),
    parts[3],
    parts[4],
  ].join("");
  const bytes = compact.match(/../g)!;
  return `VMware-${bytes.slice(0, 8).join(" ")}-${bytes.slice(8).join(" ")}`;
}

/** Percent-encodes everything except A-Za-z0-9-._~ (Rust's urlencoding::encode). */
function strictEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formBody(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${strictEncode(key)}=${strictEncode(value)}`).join("&");
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function postForm(
  fetchFn: FetchLike,
  url: string,
  params: ReadonlyArray<readonly [string, string]>,
  kind: GpErrorKind,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "User-Agent": GP_API_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody(params),
    });
  } catch (cause) {
    throw new GpError(kind, `Could not reach ${new URL(url).host}: ${String(cause)}`);
  }
  const body = await response.text();
  if (!response.ok) {
    const reason = response.headers.get("x-private-pan-globalprotect") ?? response.statusText;
    throw new GpError(
      kind,
      `${new URL(url).pathname} returned ${response.status}${reason ? `: ${reason}` : ""}`,
    );
  }
  return body;
}

export function parsePrelogin(xml: string, kind: GpErrorKind): SamlPrelogin {
  const doc = parseXml(xml);
  const status = firstText(doc, "status");
  if (status?.toLowerCase() !== "success") {
    throw new GpError(kind, firstText(doc, "msg") || "Prelogin failed");
  }
  const method = firstText(doc, "saml-auth-method");
  const request = firstText(doc, "saml-request");
  if (!method || !request) {
    throw new GpError(
      "unsupported",
      "This portal uses password login; only SAML sign-in is supported.",
    );
  }
  const decoded = Base64.decodeString(request);
  if (Result.isFailure(decoded)) throw new GpError(kind, "Could not decode the SAML request");
  return { samlRequest: decoded.success, region: firstText(doc, "region") || "Unknown" };
}

export async function prelogin(
  fetchFn: FetchLike,
  server: string,
  as: "portal" | "gateway",
  profile: GpProfile,
): Promise<SamlPrelogin> {
  const path = as === "portal" ? "/global-protect/prelogin.esp" : "/ssl-vpn/prelogin.esp";
  const body = await postForm(
    fetchFn,
    `${server}${path}`,
    [
      ["tmp", "tmp"],
      ["clientVer", CLIENT_VER],
      ["clientos", "Linux"],
      ["os-version", OS_VERSION],
      ["host-id", profile.hostId],
      ["ipv6-support", "yes"],
      ["default-browser", as === "portal" ? "-10" : "0"],
      ["cas-support", "yes"],
      ["data", CAS_DATA],
    ],
    as === "portal" ? "portal" : "gateway",
  );
  return parsePrelogin(body, as === "portal" ? "portal" : "gateway");
}

function tagValue(html: string, tag: string): string | undefined {
  // Same as gpapi: greedy, single-line match, typically inside an HTML comment.
  return new RegExp(`<${tag}>(.*)</${tag}>`).exec(html)?.[1];
}

function credentialOrThrow(
  username: string | undefined,
  preloginCookie: string | undefined,
  portalUserauthcookie: string | undefined,
): SamlCredential {
  const usable = (value: string | undefined) => (value && value.length > 5 ? value : undefined);
  const prelogin = usable(preloginCookie);
  const userauth = usable(portalUserauthcookie);
  if (!username || (!prelogin && !userauth)) {
    throw new GpError("auth", "Sign-in finished without a usable GlobalProtect cookie.");
  }
  return {
    username,
    ...(prelogin ? { preloginCookie: prelogin } : {}),
    ...(userauth ? { portalUserauthcookie: userauth } : {}),
  };
}

/**
 * Reads the SAML result GlobalProtect embeds in the final page. Returns null when the
 * page is not the result yet; throws when the portal reports a failed sign-in.
 */
export function readSamlResultFromHtml(html: string): SamlCredential | null {
  const status = tagValue(html, "saml-auth-status");
  if (status === undefined) {
    const callback = /globalprotectcallback:[^"]+/.exec(html)?.[0];
    return callback ? readGpCallback(callback.replace(/&amp;/g, "&")) : null;
  }
  if (status !== "1") throw new GpError("auth", `Sign-in failed (saml-auth-status ${status}).`);
  return credentialOrThrow(
    tagValue(html, "saml-username"),
    tagValue(html, "prelogin-cookie"),
    tagValue(html, "portal-userauthcookie"),
  );
}

/** Parses a `globalprotectcallback:` URL (CAS token or base64 SAML result). */
export function readGpCallback(url: string): SamlCredential | null {
  const data = url.replace(/^globalprotectcallback:/, "").replace(/^\/+/, "");
  if (data.startsWith("cas-as")) {
    let decoded = data;
    try {
      decoded = decodeURIComponent(data);
    } catch {}
    const fields = new Map(
      decoded.split("&").map((pair) => {
        const [key = "", value = ""] = pair.split("=");
        return [key, decodeURIComponent(value.replace(/\+/g, " "))] as const;
      }),
    );
    const username = fields.get("un") ?? fields.get("username");
    const token = fields.get("token");
    if (!username || !token) throw new GpError("auth", "CAS sign-in returned no token.");
    return { username, token };
  }
  const html = Base64.decodeString(data);
  return Result.isSuccess(html) ? readSamlResultFromHtml(html.success) : null;
}

function credentialParams(credential: SamlCredential): Array<[string, string]> {
  return [
    ["user", credential.username],
    ["passwd", "SAMLPASS"],
    ["prelogin-cookie", credential.preloginCookie ?? ""],
    ["portal-userauthcookie", credential.portalUserauthcookie || "empty"],
    ["portal-prelogonuserauthcookie", credential.portalPrelogonUserauthcookie || "empty"],
    ["token", credential.token ?? ""],
  ];
}

export interface GpGateway {
  readonly name: string;
  readonly address: string;
  readonly priority: number;
  readonly rules: ReadonlyArray<{ readonly name: string; readonly priority: number }>;
}

export interface PortalConfig {
  readonly gateways: ReadonlyArray<GpGateway>;
  readonly userauthcookie: string;
  readonly prelogonUserauthcookie: string;
}

/** The node's own <priority> child; missing or invalid sorts last. */
function parsePriority(node: XmlNode): number {
  const text = childPath(node, ["priority"])?.text.trim();
  const value = text ? Number(text) : Number.NaN;
  return Number.isInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
}

export function parsePortalConfig(xml: string, portalHost: string): PortalConfig {
  const root = parseXml(xml);
  const list = childPath(findFirst(root, "gateways"), ["external", "list"]);
  const gateways = childrenNamed(list, "entry").map((entry) => ({
    address: entry.attrs.name ?? "",
    name: firstText(entry, "description") || entry.attrs.name || "",
    priority: parsePriority(entry),
    rules: childrenNamed(childPath(entry, ["priority-rule"]), "entry").map((rule) => ({
      name: rule.attrs.name ?? "",
      priority: parsePriority(rule),
    })),
  }));
  return {
    gateways:
      gateways.length > 0
        ? gateways
        : [{ name: portalHost, address: portalHost, priority: 0, rules: [] }],
    userauthcookie: firstText(root, "portal-userauthcookie") ?? "",
    prelogonUserauthcookie: firstText(root, "portal-prelogonuserauthcookie") ?? "",
  };
}

export async function portalGetConfig(
  fetchFn: FetchLike,
  portal: string,
  credential: SamlCredential,
  profile: GpProfile,
): Promise<PortalConfig> {
  const body = await postForm(
    fetchFn,
    `${portal}/global-protect/getconfig.esp`,
    [
      ...credentialParams(credential),
      ["inputStr", ""],
      ["ok", "Login"],
      ["clientVer", CLIENT_VER],
      ["clientos", "Linux"],
      ["clientgpversion", CLIENT_GP_VERSION],
      ["computer", profile.computer],
      ["os-version", OS_VERSION],
      ["host-id", profile.hostId],
      ["ipv6-support", "yes"],
      ["serialno", serialFromUuid(profile.hostId)],
      ["csc-digest", ""],
      ["config-digest", ""],
      ["csc-support", "no"],
      ["host", hostOf(portal)],
      ["swg-auth-token", "0"],
      ["swg-nonce", "0"],
    ],
    "portal",
  );
  return parsePortalConfig(body, hostOf(portal));
}

/** Region rules first (lowest matching rule priority), else lowest gateway priority. */
export function selectGateway(gateways: ReadonlyArray<GpGateway>, region: string): GpGateway {
  let best: { gateway: GpGateway; priority: number } | undefined;
  for (const gateway of gateways) {
    for (const rule of gateway.rules) {
      if (
        (rule.name === region || rule.name === "Any") &&
        (!best || rule.priority < best.priority)
      ) {
        best = { gateway, priority: rule.priority };
      }
    }
  }
  if (best) return best.gateway;
  return gateways.reduce((min, gateway) => (gateway.priority < min.priority ? gateway : min));
}

const usableArg = (value: string | undefined) =>
  value === undefined || value === "" || value === "(null)" || value === "-1" ? undefined : value;

/** Builds the openconnect GP cookie from a login.esp JNLP response. */
export function parseGatewayLogin(xml: string, computer: string): string {
  if (xml.trim() === "") throw new GpError("gateway", "Gateway login returned an empty response.");
  if (xml.includes("Challenge")) {
    throw new GpError(
      "unsupported",
      "The gateway asked for a one-time password; that isn't supported yet.",
    );
  }
  const doc = parseXml(xml);
  const jnlp = findFirst(doc, "jnlp");
  if (!jnlp || (jnlp.attrs.status !== undefined && jnlp.attrs.status !== "success")) {
    throw new GpError("gateway", firstText(doc, "msg") || "Gateway login was rejected.");
  }
  const args = childrenNamed(childPath(jnlp, ["application-desc"]), "argument").map((arg) => {
    try {
      return usableArg(decodeURIComponent(arg.text.trim()));
    } catch {
      return usableArg(arg.text.trim());
    }
  });
  const authcookie = args[1];
  const user = args[4];
  if (!authcookie || !user) throw new GpError("gateway", "Gateway login returned no auth cookie.");
  const fields: Array<[string, string | undefined]> = [
    ["authcookie", authcookie],
    ["persistent-cookie", args[2]],
    ["portal", args[3]],
    ["user", user],
    ["domain", args[7]],
    ["preferred-ip", args[15]],
    ["preferred-ipv6", args[18]],
    ["computer", computer],
  ];
  return fields
    .filter((field): field is [string, string] => field[1] !== undefined)
    .map(([key, value]) => `${key}=${strictEncode(value)}`)
    .join("&");
}

export async function gatewayLogin(
  fetchFn: FetchLike,
  gateway: string,
  credential: SamlCredential,
  profile: GpProfile,
  context: { readonly fromPortal: boolean; readonly clientIp?: string },
): Promise<string> {
  const host = hostOf(gateway);
  const body = await postForm(
    fetchFn,
    `${gateway}/ssl-vpn/login.esp`,
    [
      ...credentialParams(credential),
      ["prot", "https:"],
      ["jnlpReady", "jnlpReady"],
      ["ok", "Login"],
      ["direct", "yes"],
      ["ipv6-support", "yes"],
      ["clientVer", CLIENT_VER],
      ["clientos", "Linux"],
      ["computer", profile.computer],
      ["inputStr", ""],
      ["os-version", OS_VERSION],
      ["server", host],
      ["host-id", profile.hostId],
      ["serialno", serialFromUuid(profile.hostId)],
      ["preferred-ip", ""],
      ["preferred-ipv6", ""],
      ["clientgpversion", CLIENT_GP_VERSION],
      ...(context.fromPortal
        ? ([
            ["host", host],
            ["gw", host],
            ["gateway-name", host],
            ["internal", "no"],
            ["selection-type", "auto"],
            ["client-ipv6", ""],
            ...(context.clientIp ? ([["client-ip", context.clientIp]] as const) : []),
          ] as const)
        : []),
    ],
    "gateway",
  );
  return parseGatewayLogin(body, profile.computer);
}

/** SAML result from the portal used as a gateway credential (portal-userauthcookie path). */
export function portalCookieCredential(
  username: string,
  config: PortalConfig,
): SamlCredential | null {
  const usable = (value: string) => (value && value !== "empty" ? value : undefined);
  const userauth = usable(config.userauthcookie);
  const prelogon = usable(config.prelogonUserauthcookie);
  if (!userauth && !prelogon) return null;
  return {
    username,
    portalUserauthcookie: userauth ?? prelogon!,
    ...(prelogon ? { portalPrelogonUserauthcookie: prelogon } : {}),
  };
}
