import { execFile } from "node:child_process";
import { loopbackOAuth } from "../lib/oauth.js";
import { GSC_SCOPE, gscQueries } from "../lib/searchdata.js";

export function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

/**
 * Google sign-in for Search Console. Mutates `values` (the .env map) with the refresh token;
 * the caller writes the file. Never prints a secret.
 */
export async function signInGsc(values: Map<string, string>, opts: { open?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const clientId = values.get("GSC_OAUTH_CLIENT_ID");
  const clientSecret = values.get("GSC_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return { ok: false, message: "set GSC_OAUTH_CLIENT_ID and GSC_OAUTH_CLIENT_SECRET first (a Google OAuth client of type \"Desktop app\")" };
  }
  console.log("Opening Google sign-in. Choose the account that can see your Search Console property and approve read-only access...");
  const { refreshToken } = await loopbackOAuth({
    clientId,
    clientSecret,
    scope: GSC_SCOPE,
    openUrl: (url) => (opts.open === false ? console.log(`\nOpen this URL to sign in:\n${url}\n`) : openBrowser(url)),
  });
  values.set("GSC_OAUTH_REFRESH_TOKEN", refreshToken);
  const site = values.get("GSC_SITE_URL");
  if (!site) return { ok: true, message: "signed in; set GSC_SITE_URL (e.g. sc-domain:example.com) to read data" };
  try {
    const rows = await gscQueries({ siteUrl: site, auth: { kind: "oauth", oauth: { clientId, clientSecret, refreshToken } }, days: 28, rowLimit: 5 });
    return { ok: true, message: `Search Console works for ${site}: ${rows.length ? `top query "${rows[0].query}"` : "no queries in the last 28 days"}` };
  } catch (err) {
    return { ok: false, message: `signed in, but reading ${site} failed: ${(err as Error).message}` };
  }
}
