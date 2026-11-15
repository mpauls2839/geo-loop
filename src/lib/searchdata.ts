import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

// Real search-demand sources for question discovery:
// - Google Search Console (your own site's queries; service-account auth, read-only scope)
// - Google Autocomplete (public, keyless, unofficial endpoint; best effort and politely rate-limited)

type FetchLike = typeof fetch;

// ---------- Google Search Console ----------

export type GscRow = { query: string; clicks: number; impressions: number; ctr: number; position: number };
type ServiceAccount = { client_email: string; private_key: string };

/** GSC_SERVICE_ACCOUNT_JSON (raw JSON or base64) or GSC_SERVICE_ACCOUNT_FILE (path). */
export function loadServiceAccount(env = process.env): ServiceAccount | null {
  let raw = env.GSC_SERVICE_ACCOUNT_JSON?.trim();
  if (raw && !raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
  if (!raw && env.GSC_SERVICE_ACCOUNT_FILE) raw = readFileSync(env.GSC_SERVICE_ACCOUNT_FILE, "utf8");
  if (!raw) return null;
  const j = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!j.client_email || !j.private_key) throw new Error("GSC service account JSON has no client_email/private_key");
  return { client_email: j.client_email, private_key: j.private_key };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function serviceAccountJwt(sa: ServiceAccount, scope: string, now = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(sig)}`;
}

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/** Your own Google sign-in (OAuth refresh token from `geo-loop auth gsc`), for orgs that block service-account keys. */
export type GscOAuth = { clientId: string; clientSecret: string; refreshToken: string };
export type GscAuth = { kind: "oauth"; oauth: GscOAuth } | { kind: "service_account"; sa: ServiceAccount };

/** Prefers your own sign-in (refresh token) over a service-account key. */
export function loadGscAuth(env = process.env): GscAuth | null {
  if (env.GSC_OAUTH_REFRESH_TOKEN && env.GSC_OAUTH_CLIENT_ID && env.GSC_OAUTH_CLIENT_SECRET) {
    return { kind: "oauth", oauth: { clientId: env.GSC_OAUTH_CLIENT_ID, clientSecret: env.GSC_OAUTH_CLIENT_SECRET, refreshToken: env.GSC_OAUTH_REFRESH_TOKEN } };
  }
  const sa = loadServiceAccount(env);
  return sa ? { kind: "service_account", sa } : null;
}

async function accessToken(auth: GscAuth, f: FetchLike): Promise<string> {
  const body =
    auth.kind === "oauth"
      ? new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.oauth.refreshToken, client_id: auth.oauth.clientId, client_secret: auth.oauth.clientSecret })
      : new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(auth.sa, GSC_SCOPE) });
  const tok = await f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!tok.ok) {
    const hint = auth.kind === "oauth" && tok.status === 400 ? " (refresh token expired or revoked: run `geo-loop auth gsc` again)" : "";
    throw new Error(`GSC auth failed: HTTP ${tok.status}${hint}`);
  }
  return ((await tok.json()) as { access_token: string }).access_token;
}

export async function gscQueries(opts: {
  siteUrl: string;
  /** Either `auth`, or `sa` for a service account (kept for compatibility). */
  auth?: GscAuth;
  sa?: ServiceAccount;
  days?: number;
  rowLimit?: number;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<GscRow[]> {
  const f = opts.fetchImpl ?? fetch;
  const auth: GscAuth | undefined = opts.auth ?? (opts.sa ? { kind: "service_account", sa: opts.sa } : undefined);
  if (!auth) throw new Error("GSC: no credentials (run `geo-loop auth gsc`, or set a service-account key)");
  const access_token = await accessToken(auth, f);
  const end = opts.now ?? new Date();
  const start = new Date(end.getTime() - (opts.days ?? 28) * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const r = await f(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(opts.siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate: day(start), endDate: day(end), dimensions: ["query"], rowLimit: opts.rowLimit ?? 1000 }),
  });
  if (r.status === 403) {
    throw new Error(
      auth.kind === "oauth"
        ? `GSC: your Google account has no access to ${opts.siteUrl} (check the property name, e.g. sc-domain:example.com)`
        : `GSC: the service account has no access to ${opts.siteUrl} (add it as a user in Search Console)`,
    );
  }
  if (!r.ok) throw new Error(`GSC query failed: HTTP ${r.status}`);
  const j = (await r.json()) as { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] };
  return (j.rows ?? []).map((x) => ({ query: x.keys[0], clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position }));
}

// ---------- Google Autocomplete (public) ----------

export const EXPANSIONS = ["{t}", "how to {t}", "{t} not working", "{t} vs", "best {t}", "{t} alternative", "why {t}", "{t} error"];

export async function autocomplete(
  seedTerms: string[],
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; expansions?: string[]; delayMs?: number } = {},
): Promise<{ query: string; seed: string; rank: number }[]> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const out: { query: string; seed: string; rank: number }[] = [];
  for (const t of seedTerms) {
    for (const pattern of opts.expansions ?? EXPANSIONS) {
      const q = pattern.replace("{t}", t);
      try {
        const r = await f(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`, {
          headers: { "user-agent": "geo-loop (+https://github.com/mpauls2839/geo-loop)" },
        });
        if (r.ok) {
          const j = (await r.json()) as [string, string[]];
          (j[1] ?? []).forEach((s, i) => out.push({ query: s.toLowerCase(), seed: t, rank: i + 1 }));
        }
      } catch {
        // best effort: a failed expansion just yields nothing
      }
      await sleep(opts.delayMs ?? 300);
    }
  }
  return out;
}
