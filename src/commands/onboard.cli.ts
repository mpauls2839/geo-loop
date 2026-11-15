import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { checkKeys, KEYS, mask, parseEnv, protectEnv, renderEnv, writeEnvFile, type Check, type KeySpec } from "./onboard.js";

function ask(prompt: string, hidden: boolean): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the prompt once; swallow every echoed keystroke so the secret never reaches the screen.
      let shown = false;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (!shown && s.includes(prompt)) {
          process.stdout.write(prompt);
          shown = true;
        }
      };
    }
    rl.question(prompt, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      done(a.trim());
    });
  });
}

const GROUP_TITLES = {
  engines: "AI engines (needed to probe)",
  shipping: "Shipping (needed to publish blog changes and open PRs)",
  measurement: "Measurement (needed for the weekly steer: AI-referred signups, Search Console)",
} as const;

function printChecks(checks: Check[]) {
  const icon = { ok: "ok     ", invalid: "INVALID", unchecked: "-      ", missing: "MISSING" } as const;
  console.log("\nKey check");
  for (const c of checks) console.log(`  ${icon[c.status]} ${c.name.padEnd(26)} ${c.detail}`);
}

export function register(program: Command) {
  program
    .command("onboard")
    .description("set up geo-loop in this folder: starter config and API keys in a private .env (hidden input, never printed)")
    .option("--check", "only validate the keys already in .env")
    .option("--only <keys>", "comma-separated key names to set, e.g. AI_GATEWAY_API_KEY")
    .option("--from-env", "non-interactive: copy known keys from the current environment into .env (for CI / cloud routines)")
    .action(async (o: { check?: boolean; only?: string; fromEnv?: boolean }) => {
      const dir = process.cwd();
      const envPath = resolve(dir, ".env");
      const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      const values = parseEnv(original);

      const guard = protectEnv(dir);
      if (guard.gitignoreUpdated) console.log("Added .env to .gitignore.");
      if (guard.tracked) {
        console.error(
          "STOP: .env is tracked by git, so keys in it may already be in your history.\n" +
            "Run `git rm --cached .env`, commit, and rotate any keys that were in it. Then run onboard again.",
        );
        process.exitCode = 1;
        return;
      }

      let cfg: { sanityProjectId?: string; githubRepo?: string } = {};
      const loaded = await loadConfig(program.opts().config).catch(() => null);
      if (loaded) cfg = { sanityProjectId: loaded.config.sanity?.projectId, githubRepo: loaded.config.github?.repo };

      if (!o.check) {
        const only = o.only ? new Set(o.only.split(",").map((s) => s.trim())) : null;
        const specs = KEYS.filter((k) => !only || only.has(k.name));
        if (only && specs.length !== only.size) {
          console.error(`Unknown key(s). Known: ${KEYS.map((k) => k.name).join(", ")}`);
          process.exitCode = 1;
          return;
        }

        if (o.fromEnv) {
          let n = 0;
          for (const k of specs) if (process.env[k.name] && !values.has(k.name)) (values.set(k.name, process.env[k.name]!), n++);
          console.log(`Copied ${n} key(s) from the environment.`);
        } else {
          if (!process.stdin.isTTY) {
            console.error("onboard needs an interactive terminal. In CI, use `geo-loop onboard --from-env`.");
            process.exitCode = 1;
            return;
          }
          if (!loaded && !only) await maybeCreateConfig(dir);
          console.log("\nPaste each key at its prompt. Input is hidden. Enter keeps the current value; type - to clear it.");
          for (const group of ["engines", "shipping", "measurement"] as const) {
            const groupSpecs = specs.filter((k) => k.group === group);
            if (!groupSpecs.length) continue;
            console.log(`\n== ${GROUP_TITLES[group]} ==`);
            if (!only && group !== "engines") {
              const yes = await ask(`Set up ${group} keys now? (y/N) `, false);
              if (!/^y/i.test(yes)) continue;
            }
            for (const k of groupSpecs) await promptKey(k, values);
          }
        }
        writeEnvFile(envPath, renderEnv(original, values));
        console.log(`\nSaved ${envPath} (permissions 600, gitignored). Values were not printed.`);
      }

      const checks = await checkKeys(values, cfg);
      printChecks(checks);
      const bad = checks.filter((c) => c.status === "invalid" || c.status === "missing");
      if (bad.length) {
        console.log(`\nFix with: geo-loop onboard --only ${bad.filter((b) => b.name !== "engines").map((b) => b.name).join(",") || "AI_GATEWAY_API_KEY"}`);
        process.exitCode = 1;
      } else {
        console.log("\nNext: geo-loop config check && geo-loop probe");
      }
    });
}

async function promptKey(k: KeySpec, values: Map<string, string>) {
  console.log(`\n${k.name}  [${k.secret ? mask(values.get(k.name)) : values.get(k.name) || "not set"}]`);
  console.log(`  ${k.help}`);
  const label = k.default && !values.get(k.name) ? `  value (default ${k.default}): ` : "  value: ";
  const v = await ask(label, k.secret);
  if (v === "-") values.set(k.name, "");
  else if (v) values.set(k.name, v);
  else if (k.default && !values.get(k.name)) values.set(k.name, k.default);
}

async function maybeCreateConfig(dir: string) {
  const yes = await ask("No geo-loop.config.ts here. Create a starter config? (Y/n) ", false);
  if (/^n/i.test(yes)) return;
  const name = (await ask("  Brand name: ", false)) || "Acme";
  const domain = ((await ask("  Domain (e.g. acme.dev): ", false)) || "acme.dev").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const file = resolve(dir, "geo-loop.config.ts");
  writeFileSync(
    file,
    `// geo-loop config. Edit the questions: they are what your buyers ask AI assistants.
export default {
  brand: { name: ${JSON.stringify(name)}, domain: ${JSON.stringify(domain)}, aliases: [] },
  site: { baseUrl: ${JSON.stringify(`https://${domain}`)}, blogPath: "/blog/" },
  positioning: { line: "", bannedPhrases: [] },
  questions: [
    { id: "q1", topic: "general", text: "What is the best tool for <your category>?" },
  ],
  engines: [{ id: "claude" }, { id: "chatgpt" }, { id: "perplexity" }],
};
`,
  );
  console.log(`  Wrote ${file}. Edit the questions before your first probe.`);
}
