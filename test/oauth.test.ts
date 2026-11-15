import { describe, expect, it } from "vitest";
import { loopbackOAuth } from "../src/lib/oauth.ts";
import { gscQueries, loadGscAuth } from "../src/lib/searchdata.ts";

describe("Google sign-in (loopback + PKCE)", () => {
  it("receives the code on 127.0.0.1, checks state, exchanges it with the PKCE verifier", async () => {
    let tokenBody: URLSearchParams | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      tokenBody = init?.body as URLSearchParams;
      return new Response(JSON.stringify({ refresh_token: "rt-123", scope: "s" }));
    }) as typeof fetch;
    let consentUrl = "";
    const res = await loopbackOAuth({
      clientId: "cid", clientSecret: "csec", scope: "s", fetchImpl: fakeFetch,
      openUrl: async (url) => {
        consentUrl = url;
        const u = new URL(url);
        expect(u.searchParams.get("code_challenge_method")).toBe("S256");
        expect(u.searchParams.get("access_type")).toBe("offline");
        const redirect = u.searchParams.get("redirect_uri")!;
        expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        // A forged redirect with the wrong state is rejected...
        // ...and the real one (browser after consent) succeeds.
        await fetch(`${redirect}/?code=abc&state=${u.searchParams.get("state")}`);
      },
    });
    expect(res.refreshToken).toBe("rt-123");
    expect(tokenBody?.get("code")).toBe("abc");
    expect(tokenBody?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(consentUrl).searchParams.get("code_challenge")).not.toBe(tokenBody?.get("code_verifier"));
  });

  it("rejects a redirect whose state doesn't match", async () => {
    await expect(
      loopbackOAuth({
        clientId: "c", clientSecret: "s", scope: "x", fetchImpl: (async () => new Response("{}")) as typeof fetch,
        openUrl: async (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri")!;
          await fetch(`${redirect}/?code=abc&state=forged`);
        },
      }),
    ).rejects.toThrow(/state mismatch/);
  });
});

describe("Search Console with a refresh token", () => {
  it("prefers your own sign-in over a service account and refreshes an access token", async () => {
    const auth = loadGscAuth({ GSC_OAUTH_CLIENT_ID: "c", GSC_OAUTH_CLIENT_SECRET: "s", GSC_OAUTH_REFRESH_TOKEN: "rt" });
    expect(auth?.kind).toBe("oauth");
    const seen: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("oauth2")) {
        seen.push((init?.body as URLSearchParams).get("grant_type")!);
        return new Response(JSON.stringify({ access_token: "at" }));
      }
      return new Response(JSON.stringify({ rows: [{ keys: ["n8n webhook empty body"], clicks: 1, impressions: 300, ctr: 0.003, position: 7 }] }));
    }) as typeof fetch;
    const rows = await gscQueries({ siteUrl: "sc-domain:x.io", auth: auth!, fetchImpl: f });
    expect(seen).toEqual(["refresh_token"]);
    expect(rows[0].query).toBe("n8n webhook empty body");
  });

  it("tells you to sign in again when the refresh token is revoked", async () => {
    const auth = loadGscAuth({ GSC_OAUTH_CLIENT_ID: "c", GSC_OAUTH_CLIENT_SECRET: "s", GSC_OAUTH_REFRESH_TOKEN: "old" })!;
    const f = (async () => new Response("{}", { status: 400 })) as typeof fetch;
    await expect(gscQueries({ siteUrl: "sc-domain:x.io", auth, fetchImpl: f })).rejects.toThrow(/geo-loop auth gsc/);
  });
});
