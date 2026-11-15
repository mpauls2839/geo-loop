import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Google OAuth for installed apps: loopback redirect + PKCE (RFC 8252 / RFC 7636).
// The user signs in in their own browser; we only ever receive a one-time code on 127.0.0.1.

type FetchLike = typeof fetch;

export type LoopbackAuthOptions = {
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Opens the consent URL (browser). Tests pass a fake that "visits" the redirect. */
  openUrl: (url: string) => void | Promise<void>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export async function loopbackOAuth(o: LoopbackAuthOptions): Promise<{ refreshToken: string; scope: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const f = o.fetchImpl ?? fetch;

  let finish!: (code: string) => void;
  let fail!: (err: Error) => void;
  const gotCode = new Promise<string>((res, rej) => ((finish = res), (fail = rej)));
  gotCode.catch(() => {}); // a bad redirect can arrive before we await it; the await below still throws

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const ok = !err && code && url.searchParams.get("state") === state;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(ok ? "<p>geo-loop is connected. You can close this tab.</p>" : "<p>Sign-in failed. Return to the terminal.</p>");
    if (ok) finish(code!);
    else fail(new Error(err ? `Google returned: ${err}` : "state mismatch: ignoring an unexpected redirect"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: o.scope,
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  const timer = setTimeout(() => fail(new Error("timed out waiting for the Google sign-in")), o.timeoutMs ?? 300_000);
  try {
    await o.openUrl(auth.toString());
    const code = await gotCode;
    const r = await f("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: o.clientId,
        client_secret: o.clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
    const j = (await r.json()) as { refresh_token?: string; scope?: string };
    if (!j.refresh_token) throw new Error("Google returned no refresh token (remove geo-loop's access at myaccount.google.com/permissions and try again)");
    return { refreshToken: j.refresh_token, scope: j.scope ?? o.scope };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
