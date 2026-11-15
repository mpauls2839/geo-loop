import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { gscQueries, loadServiceAccount } from "../lib/searchdata.js";

// Onboarding: collect keys into a local .env safely.
// - secrets are read with hidden input and never printed (only "set, ends ...abcd")
// - .env is written atomically with mode 0600 and added to .gitignore
// - each key is checked with a free, read-only call where one exists

export type KeySpec = {
  name: string;
  group: "engines" | "shipping" | "measurement";
  secret: boolean;
  required?: boolean;
  help: string;
  default?: string;
};

export const KEYS: KeySpec[] = [
  { name: "AI_GATEWAY_API_KEY", group: "engines", secret: true, help: "Vercel AI Gateway key: one key for Claude, ChatGPT and Perplexity. vercel.com/dashboard -> AI Gateway -> API Keys." },
  { name: "ANTHROPIC_API_KEY", group: "engines", secret: true, help: "Optional. Direct Anthropic key; used instead of the gateway for Claude and the judge." },
  { name: "OPENAI_API_KEY", group: "engines", secret: true, help: "Optional. OpenAI key for the ChatGPT engine; also the eval judge's key for any OpenAI-compatible endpoint." },
  { name: "OPENAI_BASE_URL", group: "engines", secret: false, help: "Optional. OpenAI-compatible endpoint for the eval judge (OpenRouter, Ollama http://localhost:11434/v1, LM Studio, vLLM). Leave empty for OpenAI." },
  { name: "PERPLEXITY_API_KEY", group: "engines", secret: true, help: "Optional. Direct Perplexity key for the Sonar engine." },
  { name: "SANITY_WRITE_TOKEN", group: "shipping", secret: true, help: "Sanity API token with Editor rights (sanity.io/manage -> project -> API -> Tokens). Needed to ship blog changes." },
  { name: "GITHUB_TOKEN", group: "shipping", secret: true, help: "Fine-grained GitHub token with Contents + Pull requests read/write on your site repo. Needed for the code-PR lane." },
  { name: "POSTHOG_PERSONAL_API_KEY", group: "measurement", secret: true, help: "PostHog personal API key with read access (Settings -> Personal API keys). Used to count AI-referred visits and signups." },
  { name: "POSTHOG_PROJECT_ID", group: "measurement", secret: false, help: "PostHog project id (number in the project URL)." },
  { name: "POSTHOG_HOST", group: "measurement", secret: false, help: "PostHog API host.", default: "https://us.posthog.com" },
  { name: "GSC_SERVICE_ACCOUNT_JSON", group: "measurement", secret: true, help: "For cloud/hosted runs: the service-account key itself instead of a file (base64 is easiest: `base64 -i key.json | pbcopy`)." },
  { name: "GSC_SERVICE_ACCOUNT_FILE", group: "measurement", secret: false, help: "Path to a Google service-account JSON file. Add its client_email as a user in Search Console." },
  { name: "GSC_SITE_URL", group: "measurement", secret: false, help: "Search Console property, e.g. sc-domain:example.com or https://example.com/." },
];

export function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let v = match[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    m.set(match[1], v);
  }
  return m;
}

/** Rewrites values in place, keeps comments and unknown lines, appends new keys. */
export function renderEnv(original: string, values: Map<string, string>): string {
  const seen = new Set<string>();
  const lines = original.split(/\r?\n/).map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !values.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${quote(values.get(match[1])!)}`;
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  const added = [...values].filter(([k, v]) => !seen.has(k) && v !== "");
  if (added.length) {
    if (lines.length) lines.push("");
    lines.push("# added by geo-loop onboard");
    for (const [k, v] of added) lines.push(`${k}=${quote(v)}`);
  }
  return lines.join("\n") + "\n";
}

function quote(v: string) {
  return /[\s#"'$`\\]/.test(v) ? `"${v.replace(/(["\\$`])/g, "\\$1")}"` : v;
}

export function writeEnvFile(path: string, text: string) {
  const tmp = join(dirname(path), `.env.tmp-${process.pid}`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function mask(v: string | undefined) {
  if (!v) return "not set";
  return v.length <= 8 ? "set" : `set, ends ...${v.slice(-4)}`;
}

/** Makes sure .env is gitignored; reports if it is already tracked by git. */
export function protectEnv(dir: string): { gitignoreUpdated: boolean; tracked: boolean } {
  const gi = resolve(dir, ".gitignore");
  const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const has = current.split(/\r?\n/).some((l) => /^\/?\.env(\*|\.local)?$/.test(l.trim()));
  let gitignoreUpdated = false;
  if (!has) {
    writeFileSync(gi, current + (current && !current.endsWith("\n") ? "\n" : "") + ".env\n.env.local\n");
    gitignoreUpdated = true;
  }
  let tracked = false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: dir, stdio: "ignore" });
    tracked = true;
  } catch {
    tracked = false;
  }
  return { gitignoreUpdated, tracked };
}

export type Check = { name: string; status: "ok" | "invalid" | "unchecked" | "missing"; detail: string };

type FetchLike = typeof fetch;

/** Free, read-only validation calls. Never sends a key anywhere except its own provider. */
export async function checkKeys(
  env: Map<string, string>,
  opts: { sanityProjectId?: string; githubRepo?: string; gscSiteUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<Check[]> {
  const f = opts.fetchImpl ?? fetch;
  const get = (k: string) => env.get(k) || undefined;
  const checks: Check[] = [];
  const status = async (name: string, run: () => Promise<Check>) => {
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ name, status: "unchecked", detail: `check failed: ${(err as Error).message}` });
    }
  };

  const gw = get("AI_GATEWAY_API_KEY");
  if (gw)
    await status("AI_GATEWAY_API_KEY", async () => {
      const r = await f("https://ai-gateway.vercel.sh/v1/credits", { headers: { Authorization: `Bearer ${gw}` } });
      if (r.status === 401 || r.status === 403) return { name: "AI_GATEWAY_API_KEY", status: "invalid", detail: `gateway rejected the key (HTTP ${r.status})` };
      if (!r.ok) return { name: "AI_GATEWAY_API_KEY", status: "unchecked", detail: `gateway returned HTTP ${r.status}` };
      const j = (await r.json()) as { balance?: string };
      return { name: "AI_GATEWAY_API_KEY", status: "ok", detail: `valid, balance $${j.balance ?? "?"}` };
    });

  const an = get("ANTHROPIC_API_KEY");
  if (an)
    await status("ANTHROPIC_API_KEY", async () => {
      try {
        await new Anthropic({ apiKey: an, baseURL: "https://api.anthropic.com", maxRetries: 0 }).models.list({ limit: 1 });
        return { name: "ANTHROPIC_API_KEY", status: "ok", detail: "valid" };
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
          return { name: "ANTHROPIC_API_KEY", status: "invalid", detail: "Anthropic rejected the key" };
        throw err;
      }
    });

  const oa = get("OPENAI_API_KEY");
  if (oa)
    await status("OPENAI_API_KEY", async () => {
      try {
        await new OpenAI({ apiKey: oa, baseURL: get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1", maxRetries: 0 }).models.list();
        return { name: "OPENAI_API_KEY", status: "ok", detail: "valid" };
      } catch (err) {
        if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError)
          return { name: "OPENAI_API_KEY", status: "invalid", detail: "OpenAI rejected the key" };
        throw err;
      }
    });

  if (get("PERPLEXITY_API_KEY"))
    checks.push({ name: "PERPLEXITY_API_KEY", status: "unchecked", detail: "Perplexity has no free check endpoint; the first probe will test it" });

  const sa = get("SANITY_WRITE_TOKEN");
  if (sa)
    await status("SANITY_WRITE_TOKEN", async () => {
      if (!opts.sanityProjectId) return { name: "SANITY_WRITE_TOKEN", status: "unchecked", detail: "no sanity.projectId in config yet" };
      const r = await f(`https://${opts.sanityProjectId}.api.sanity.io/v2021-06-07/users/me`, { headers: { Authorization: `Bearer ${sa}` } });
      if (r.status === 401 || r.status === 403) return { name: "SANITY_WRITE_TOKEN", status: "invalid", detail: `Sanity rejected the token (HTTP ${r.status})` };
      if (!r.ok) return { name: "SANITY_WRITE_TOKEN", status: "unchecked", detail: `Sanity returned HTTP ${r.status}` };
      return { name: "SANITY_WRITE_TOKEN", status: "ok", detail: `valid for project ${opts.sanityProjectId} (write rights are confirmed on first ship)` };
    });

  const gh = get("GITHUB_TOKEN");
  if (gh)
    await status("GITHUB_TOKEN", async () => {
      const h = { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github+json", "User-Agent": "geo-loop" };
      if (!opts.githubRepo) {
        const r = await f("https://api.github.com/user", { headers: h });
        if (r.status === 401) return { name: "GITHUB_TOKEN", status: "invalid", detail: "GitHub rejected the token" };
        return { name: "GITHUB_TOKEN", status: r.ok ? "ok" : "unchecked", detail: r.ok ? "valid (no github.repo in config to check access)" : `HTTP ${r.status}` };
      }
      const r = await f(`https://api.github.com/repos/${opts.githubRepo}`, { headers: h });
      if (r.status === 401) return { name: "GITHUB_TOKEN", status: "invalid", detail: "GitHub rejected the token" };
      if (r.status === 404) return { name: "GITHUB_TOKEN", status: "invalid", detail: `token cannot see ${opts.githubRepo}` };
      if (!r.ok) return { name: "GITHUB_TOKEN", status: "unchecked", detail: `HTTP ${r.status}` };
      const j = (await r.json()) as { permissions?: { push?: boolean } };
      return j.permissions?.push
        ? { name: "GITHUB_TOKEN", status: "ok", detail: `can push to ${opts.githubRepo}` }
        : { name: "GITHUB_TOKEN", status: "invalid", detail: `read-only on ${opts.githubRepo}; needs Contents + Pull requests write` };
    });

  const ph = get("POSTHOG_PERSONAL_API_KEY");
  if (ph)
    await status("POSTHOG_PERSONAL_API_KEY", async () => {
      const id = get("POSTHOG_PROJECT_ID");
      if (!id) return { name: "POSTHOG_PERSONAL_API_KEY", status: "unchecked", detail: "set POSTHOG_PROJECT_ID to check it" };
      const host = (get("POSTHOG_HOST") ?? "https://us.posthog.com").replace(/\/$/, "");
      const r = await f(`${host}/api/projects/${encodeURIComponent(id)}/`, { headers: { Authorization: `Bearer ${ph}` } });
      if (r.status === 401 || r.status === 403) return { name: "POSTHOG_PERSONAL_API_KEY", status: "invalid", detail: `PostHog rejected the key (HTTP ${r.status})` };
      if (!r.ok) return { name: "POSTHOG_PERSONAL_API_KEY", status: "unchecked", detail: `PostHog returned HTTP ${r.status}` };
      return { name: "POSTHOG_PERSONAL_API_KEY", status: "ok", detail: `valid for project ${id}` };
    });

  if (get("GSC_SERVICE_ACCOUNT_FILE") || get("GSC_SERVICE_ACCOUNT_JSON")) {
    const name = get("GSC_SERVICE_ACCOUNT_JSON") ? "GSC_SERVICE_ACCOUNT_JSON" : "GSC_SERVICE_ACCOUNT_FILE";
    await status(name, async () => {
      let sa: ReturnType<typeof loadServiceAccount>;
      try {
        sa = loadServiceAccount({
          GSC_SERVICE_ACCOUNT_JSON: get("GSC_SERVICE_ACCOUNT_JSON"),
          GSC_SERVICE_ACCOUNT_FILE: get("GSC_SERVICE_ACCOUNT_FILE"),
        });
      } catch (err) {
        return { name, status: "invalid", detail: (err as Error).message };
      }
      if (!sa) return { name, status: "invalid", detail: "not a service-account key" };
      const site = get("GSC_SITE_URL") ?? opts.gscSiteUrl;
      if (!site) return { name, status: "unchecked", detail: `service account ${sa.client_email}; set GSC_SITE_URL to check access` };
      try {
        const rows = await gscQueries({ siteUrl: site, sa, days: 7, rowLimit: 1, fetchImpl: f });
        return { name, status: "ok", detail: `can read Search Console for ${site} (${rows.length ? "has data" : "no rows in the last 7 days"})` };
      } catch (err) {
        return { name, status: "invalid", detail: (err as Error).message };
      }
    });
  }

  const hasEngine = ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY"].some((k) => get(k));
  if (!hasEngine) checks.unshift({ name: "engines", status: "missing", detail: "no engine key: set AI_GATEWAY_API_KEY (or per-provider keys) to probe" });
  return checks;
}
