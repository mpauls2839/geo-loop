import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { loopbackOAuth } from "../lib/oauth.js";
import { GSC_SCOPE, gscQueries } from "../lib/searchdata.js";
import { parseEnv, protectEnv, renderEnv, writeEnvFile } from "./onboard.js";

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

export function register(program: Command, _ctx: () => Promise<Ctx>) {
  const auth = program.command("auth").description("sign in to data sources with your own account");

  auth
    .command("gsc")
    .description("sign in with Google once to read Search Console (no service-account key); saves a refresh token to .env")
    .option("--no-open", "print the sign-in URL instead of opening a browser")
    .action(async (o: { open: boolean }) => {
      const envPath = resolve(process.cwd(), ".env");
      const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      const values = parseEnv(original);
      const clientId = values.get("GSC_OAUTH_CLIENT_ID") || process.env.GSC_OAUTH_CLIENT_ID;
      const clientSecret = values.get("GSC_OAUTH_CLIENT_SECRET") || process.env.GSC_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        console.error(
          "Missing GSC_OAUTH_CLIENT_ID / GSC_OAUTH_CLIENT_SECRET. Create a Google OAuth client of type \"Desktop app\"\n" +
            "(Google Cloud -> APIs & Services -> Credentials), then: geo-loop onboard --only GSC_OAUTH_CLIENT_ID,GSC_OAUTH_CLIENT_SECRET",
        );
        process.exitCode = 1;
        return;
      }
      const guard = protectEnv(process.cwd());
      if (guard.tracked) {
        console.error("STOP: .env is tracked by git. Run `git rm --cached .env` first.");
        process.exitCode = 1;
        return;
      }
      console.log("Opening Google sign-in. Approve read-only Search Console access in your browser...");
      const { refreshToken } = await loopbackOAuth({
        clientId,
        clientSecret,
        scope: GSC_SCOPE,
        openUrl: (url) => (o.open ? openBrowser(url) : console.log(`\nOpen this URL to sign in:\n${url}\n`)),
      });
      values.set("GSC_OAUTH_CLIENT_ID", clientId);
      values.set("GSC_OAUTH_CLIENT_SECRET", clientSecret);
      values.set("GSC_OAUTH_REFRESH_TOKEN", refreshToken);
      writeEnvFile(envPath, renderEnv(original, values));
      console.log(`Saved GSC_OAUTH_REFRESH_TOKEN to ${envPath} (permissions 600, gitignored). Values were not printed.`);

      const site = values.get("GSC_SITE_URL") || process.env.GSC_SITE_URL;
      if (!site) {
        console.log("Next: set the property with `geo-loop onboard --only GSC_SITE_URL` (e.g. sc-domain:example.com).");
        return;
      }
      try {
        const rows = await gscQueries({ siteUrl: site, auth: { kind: "oauth", oauth: { clientId, clientSecret, refreshToken } }, days: 28, rowLimit: 5 });
        console.log(`Search Console works for ${site}: ${rows.length ? `top query "${rows[0].query}"` : "no queries in the last 28 days"}.`);
      } catch (err) {
        console.error(`Signed in, but reading ${site} failed: ${(err as Error).message}`);
        process.exitCode = 2;
      }
    });
}
