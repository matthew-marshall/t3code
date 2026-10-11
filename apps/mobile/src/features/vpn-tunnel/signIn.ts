import {
  GpError,
  gatewayLogin,
  normalizeServer,
  portalCookieCredential,
  portalGetConfig,
  prelogin,
  selectGateway,
  type FetchLike,
  type GpProfile,
  type SamlCredential,
} from "./globalProtect";

export interface GpSignInInput {
  /** Portal (or gateway) address as the user entered it. */
  readonly server: string;
  readonly profile: GpProfile;
  /** Shows the SAML request in a WebView and resolves with the result. */
  readonly authenticate: (samlRequest: string, server: string) => Promise<SamlCredential>;
  readonly clientIp?: string;
  readonly log: (message: string) => void;
  readonly fetchFn?: FetchLike;
}

export interface GpSignInResult {
  /** Gateway host[:port] for openconnect. */
  readonly gateway: string;
  readonly cookie: string;
}

/**
 * Signs in like `gpclient connect --cookie-only`: portal first, reusing the portal's
 * cookie at the gateway when it allows that; servers that are only a gateway fall back
 * to gateway SAML.
 */
export async function signInToGlobalProtect(input: GpSignInInput): Promise<GpSignInResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const server = normalizeServer(input.server);
  try {
    return await viaPortal(input, fetchFn, server);
  } catch (error) {
    if (!(error instanceof GpError) || error.kind !== "portal") throw error;
    input.log(`Portal sign-in failed (${error.message}); trying ${server} as a gateway.`);
    return await viaGateway(input, fetchFn, server, false);
  }
}

async function viaPortal(
  input: GpSignInInput,
  fetchFn: FetchLike,
  portal: string,
): Promise<GpSignInResult> {
  input.log(`Portal prelogin: ${portal}`);
  const pre = await prelogin(fetchFn, portal, "portal", input.profile);
  const credential = await input.authenticate(pre.samlRequest, portal);
  input.log(`Signed in as ${credential.username}; fetching portal config.`);
  const config = await portalGetConfig(fetchFn, portal, credential, input.profile);
  const gateway = normalizeServer(selectGateway(config.gateways, pre.region).address);
  input.log(`Gateway: ${gateway} (region ${pre.region})`);

  const portalCredential = portalCookieCredential(credential.username, config);
  if (portalCredential) {
    try {
      const cookie = await gatewayLogin(fetchFn, gateway, portalCredential, input.profile, {
        fromPortal: true,
        ...(input.clientIp ? { clientIp: input.clientIp } : {}),
      });
      return { gateway: new URL(gateway).host, cookie };
    } catch (error) {
      if (error instanceof GpError && error.kind === "unsupported") throw error;
      input.log(
        `Gateway rejected the portal cookie (${String(error)}); signing in to the gateway.`,
      );
    }
  }
  return await viaGateway(input, fetchFn, gateway, true);
}

async function viaGateway(
  input: GpSignInInput,
  fetchFn: FetchLike,
  gateway: string,
  fromPortal: boolean,
): Promise<GpSignInResult> {
  input.log(`Gateway prelogin: ${gateway}`);
  const pre = await prelogin(fetchFn, gateway, "gateway", input.profile);
  const credential = await input.authenticate(pre.samlRequest, gateway);
  const cookie = await gatewayLogin(fetchFn, gateway, credential, input.profile, {
    fromPortal,
    ...(input.clientIp ? { clientIp: input.clientIp } : {}),
  });
  return { gateway: new URL(gateway).host, cookie };
}
