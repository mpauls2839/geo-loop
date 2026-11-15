import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { signInGsc } from "./gscauth.js";
import { parseEnv, protectEnv, renderEnv, writeEnvFile } from "./onboard.js";

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
      for (const k of ["GSC_OAUTH_CLIENT_ID", "GSC_OAUTH_CLIENT_SECRET", "GSC_SITE_URL"]) if (!values.get(k) && process.env[k]) values.set(k, process.env[k]!);
      if (protectEnv(process.cwd()).tracked) {
        console.error("STOP: .env is tracked by git. Run `git rm --cached .env` first.");
        process.exitCode = 1;
        return;
      }
      const res = await signInGsc(values, { open: o.open });
      if (values.get("GSC_OAUTH_REFRESH_TOKEN")) {
        writeEnvFile(envPath, renderEnv(original, values));
        console.log(`Saved GSC_OAUTH_REFRESH_TOKEN to ${envPath} (permissions 600, gitignored). Values were not printed.`);
      }
      (res.ok ? console.log : console.error)(res.message);
      process.exitCode = res.ok ? 0 : 1;
    });
}
