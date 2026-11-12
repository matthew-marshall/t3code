import { describe, expect, it, vi } from "vite-plus/test";

import { MISSING_GEMINI_KEY_MESSAGE, requestLiveToken } from "./gemini.ts";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("requestLiveToken", () => {
  it("trades the key for a single-use token without putting the key in the URL", async () => {
    const fetchImpl = respond(200, { name: "auth_tokens/abc" });
    await expect(requestLiveToken(" key-123 ", fetchImpl)).resolves.toBe("auth_tokens/abc");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect(url).not.toContain("key-123");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("key-123");
    expect(JSON.parse(init.body as string)).toMatchObject({ uses: 1 });
  });

  it("asks for a key before calling Gemini", async () => {
    const fetchImpl = respond(200, {});
    await expect(requestLiveToken("  ", fetchImpl)).rejects.toThrow(MISSING_GEMINI_KEY_MESSAGE);
    await expect(requestLiveToken(null, fetchImpl)).rejects.toThrow(MISSING_GEMINI_KEY_MESSAGE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says when Gemini rejects the key", async () => {
    await expect(requestLiveToken("bad", respond(403, {}))).rejects.toThrow(
      "Gemini rejected the API key",
    );
  });
});
